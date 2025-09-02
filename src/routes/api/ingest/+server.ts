import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { documents, chunks, embeddings } from '$lib/server/db/schema';
import { env } from '$env/dynamic/private';
import { randomUUID } from 'crypto';

// Improved text chunking function with better chunk size and overlap
function chunkText(text: string, chunkSize: number = 800, overlap: number = 150): string[] {
  const chunks: string[] = [];
  let start = 0;
  
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    let chunk = text.slice(start, end);
    
    // Try to break at sentence boundaries for better context
    if (end < text.length) {
      const lastPeriod = chunk.lastIndexOf('.');
      const lastNewline = chunk.lastIndexOf('\n');
      const lastQuestion = chunk.lastIndexOf('?');
      const lastExclamation = chunk.lastIndexOf('!');
      const breakPoint = Math.max(lastPeriod, lastNewline, lastQuestion, lastExclamation);
      
      if (breakPoint > start + chunkSize * 0.6) {
        chunk = text.slice(start, breakPoint + 1);
        start = breakPoint + 1;
      } else {
        start = end - overlap;
      }
    } else {
      start = end;
    }
    
    if (chunk.trim()) {
      chunks.push(chunk.trim());
    }
  }
  
  return chunks;
}

// Simple PDF text extraction using pdf2json
async function extractTextFromPDF(file: File): Promise<string> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Check if it's a valid PDF by looking for the PDF header
    const header = buffer.toString('ascii', 0, 8);
    if (!header.startsWith('%PDF-')) {
      throw new Error('Invalid PDF file. The file does not appear to be a valid PDF.');
    }
    
    console.log('Extracting text from PDF using pdf2json...');
    const PDFParser = await import('pdf2json');
    
    return new Promise((resolve, reject) => {
      const pdfParser = new PDFParser.default();
      let extractedText = '';
      
      pdfParser.on('pdfParser_dataReady', (pdfData) => {
        try {
          // Extract text from all pages
          if (pdfData.Pages && pdfData.Pages.length > 0) {
            extractedText = pdfData.Pages.map((page: any) => {
              if (page.Texts && page.Texts.length > 0) {
                return page.Texts.map((text: any) => {
                  // Decode the text (pdf2json encodes text)
                  return decodeURIComponent(text.R[0].T);
                }).join(' ');
              }
              return '';
            }).join('\n');
          }
          
          console.log(`PDF processed: ${pdfData.Pages?.length || 0} pages, ${extractedText.length} characters`);
          
          if (!extractedText || extractedText.trim() === "") {
            reject(new Error("Could not extract text from PDF"));
          } else {
            resolve(extractedText.trim());
          }
        } catch (error) {
          reject(new Error('Failed to process PDF data'));
        }
      });
      
      pdfParser.on('pdfParser_dataError', (error) => {
        reject(new Error('Failed to parse PDF: ' + (error as any).message));
      });
      
      // Parse the PDF buffer
      pdfParser.parseBuffer(buffer);
    });
    
  } catch (error) {
    console.error('PDF text extraction failed:', error);
    throw new Error('Failed to extract text from PDF. Please ensure the PDF contains readable text content.');
  }
}

// Call embedding API
async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await fetch(`${env.EMBEDDING_API_URL}/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ texts }),
  });

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.embeddings;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const session = await locals.auth();
    if (!session?.user?.id) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    let title: string;
    let content: string;
    let source: string;
    let mimeType: string;

    // Check if this is a file upload (multipart/form-data) or JSON
    const contentType = request.headers.get('content-type') || '';
    
    if (contentType.includes('multipart/form-data')) {
      // Handle file upload
      const formData = await request.formData();
      const file = formData.get('file') as File;
      
      if (!file) {
        return json({ error: 'No file provided' }, { status: 400 });
      }

      title = file.name;
      source = 'File Upload';
      mimeType = file.type;

      // Extract text based on file type
      if (file.type === 'application/pdf') {
        console.log(`Processing PDF: ${file.name} (${file.size} bytes)`);
        content = await extractTextFromPDF(file);
      } else if (file.type === 'text/plain' || file.type === 'text/markdown') {
        content = await file.text();
      } else {
        return json({ error: 'Unsupported file type. Please upload PDF or text files only.' }, { status: 400 });
      }
    } else {
      // Handle JSON data (existing functionality)
      const body = await request.json();
      ({ title, content, source, mimeType } = body);

      if (!title || !content || !source) {
        return json({ error: 'Missing required fields: title, content, source' }, { status: 400 });
      }
    }

    // Check if embedding API is available
    if (!env.EMBEDDING_API_URL) {
      return json({ error: 'Embedding API not configured' }, { status: 500 });
    }

    // Create document
    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      title,
      source,
      mimeType: mimeType || 'text/plain',
    });

    // Validate content before chunking
    console.log(`Content validation: ${content ? content.length : 0} characters`);
    
    if (!content || content.trim().length === 0) {
      return json({ error: 'No content extracted from document' }, { status: 400 });
    }
    
    // Split content into chunks
    console.log(`Creating chunks from ${content.length} characters...`);
    const textChunks = chunkText(content);
    console.log(`Created ${textChunks.length} chunks`);
    
    if (textChunks.length === 0) {
      return json({ error: 'No content chunks generated' }, { status: 400 });
    }

    // Generate embeddings
    console.log('Generating embeddings...');
    const embeddingsList = await getEmbeddings(textChunks);
    console.log(`Generated ${embeddingsList.length} embeddings`);

    // Insert chunks and embeddings
    const chunkInserts = textChunks.map((chunk, idx) => ({
      id: randomUUID(),
      documentId,
      idx,
      content: chunk,
    }));

    console.log('Inserting chunks into database...');
    await db.insert(chunks).values(chunkInserts);
    console.log(`Inserted ${chunkInserts.length} chunks`);

    // Insert embeddings
    const embeddingInserts = embeddingsList.map((embedding, idx) => ({
      chunkId: chunkInserts[idx].id,
      embedding: JSON.stringify(embedding),
    }));

    console.log('Inserting embeddings into database...');
    await db.insert(embeddings).values(embeddingInserts);
    console.log(`Inserted ${embeddingInserts.length} embeddings`);

    return json({
      success: true,
      documentId,
      chunksCount: textChunks.length,
      message: `Successfully ingested document "${title}" with ${textChunks.length} chunks`
    });

  } catch (error) {
    console.error('Error in ingest API:', error);
    return json({ error: error instanceof Error ? error.message : 'Failed to ingest document' }, { status: 500 });
  }
};
