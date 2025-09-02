import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { chunks, embeddings, documents } from '$lib/server/db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';

// Call embedding API for a single text
async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${env.EMBEDDING_API_URL}/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ texts: [text] }),
  });

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.embeddings[0];
}

// Search for similar chunks using vector similarity
async function searchSimilarChunks(queryEmbedding: number[], limit: number = 5) {
  const embeddingJson = JSON.stringify(queryEmbedding);
  
  // Use cosine similarity to find the most similar chunks
  const similarChunks = await db
    .select({
      chunkId: chunks.id,
      content: chunks.content,
      idx: chunks.idx,
      documentId: chunks.documentId,
      documentTitle: documents.title,
      documentSource: documents.source,
      similarity: sql<number>`1 - (embeddings.embedding::vector <=> ${embeddingJson}::vector)`
    })
    .from(chunks)
    .innerJoin(embeddings, eq(chunks.id, embeddings.chunkId))
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .orderBy(desc(sql<number>`1 - (embeddings.embedding::vector <=> ${embeddingJson}::vector)`))
    .limit(limit);

  return similarChunks;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const session = await locals.auth();
    if (!session?.user?.id) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { question } = body;

    if (!question) {
      return json({ error: 'Question is required' }, { status: 400 });
    }

    // Check if embedding API is available
    if (!env.EMBEDDING_API_URL) {
      return json({ error: 'Embedding API not configured' }, { status: 500 });
    }

    console.log('🔍 RAG Test - Processing question:', question);

    // Step 1: Generate embedding for the question
    console.log('📊 Step 1: Generating embedding for question...');
    const queryEmbedding = await getEmbedding(question);
    console.log('✅ Embedding generated, dimensions:', queryEmbedding.length);

    // Step 2: Search for similar chunks
    console.log('🔎 Step 2: Searching for similar chunks...');
    const similarChunks = await searchSimilarChunks(queryEmbedding, 5);
    
    // Filter by similarity threshold (30%)
    const SIMILARITY_THRESHOLD = 0.3;
    const relevantChunks = similarChunks.filter(chunk => chunk.similarity >= SIMILARITY_THRESHOLD);
    
    console.log('✅ Found', similarChunks.length, 'total chunks');
    console.log('✅ Found', relevantChunks.length, 'relevant chunks (≥30% similarity)');

    // Step 3: Return the results
    const result = {
      question,
      queryEmbedding: {
        dimensions: queryEmbedding.length,
        sample: queryEmbedding.slice(0, 5) // Show first 5 values
      },
      retrievedChunks: similarChunks.map(chunk => ({
        chunkId: chunk.chunkId,
        content: chunk.content,
        documentTitle: chunk.documentTitle,
        documentSource: chunk.documentSource,
        similarity: chunk.similarity,
        chunkIndex: chunk.idx,
        similarityPercentage: (chunk.similarity * 100).toFixed(1) + '%',
        isRelevant: chunk.similarity >= SIMILARITY_THRESHOLD
      })),
      summary: {
        totalChunksFound: similarChunks.length,
        relevantChunksFound: relevantChunks.length,
        averageSimilarity: similarChunks.length > 0 
          ? similarChunks.reduce((sum, chunk) => sum + chunk.similarity, 0) / similarChunks.length 
          : 0,
        hasRelevantContent: relevantChunks.length > 0,
        similarityThreshold: SIMILARITY_THRESHOLD * 100 + '%',
        documentsReferenced: [...new Set(similarChunks.map(c => c.documentTitle))],
        similarityRange: similarChunks.length > 0 ? {
          min: (Math.min(...similarChunks.map(c => c.similarity)) * 100).toFixed(1) + '%',
          max: (Math.max(...similarChunks.map(c => c.similarity)) * 100).toFixed(1) + '%'
        } : null
      }
    };

    console.log('🎯 RAG Test Results:', {
      question,
      chunksFound: similarChunks.length,
      topSimilarity: similarChunks[0]?.similarity || 0,
      documents: [...new Set(similarChunks.map(c => c.documentTitle))]
    });

    return json(result);

  } catch (error) {
    console.error('❌ Error in RAG test:', error);
    return json({ 
      error: 'Failed to process RAG test',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
};

// GET endpoint to show available documents
export const GET: RequestHandler = async ({ locals }) => {
  try {
    const session = await locals.auth();
    if (!session?.user?.id) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get all documents with chunk counts
    const documentsWithChunks = await db
      .select({
        id: documents.id,
        title: documents.title,
        source: documents.source,
        createdAt: documents.createdAt,
        chunkCount: sql<number>`(SELECT COUNT(*) FROM chunks WHERE chunks.document_id = documents.id)`
      })
      .from(documents)
      .orderBy(desc(documents.createdAt));

    // Get total stats
    const totalStats = await db
      .select({
        totalDocuments: sql<number>`(SELECT COUNT(*) FROM documents)`,
        totalChunks: sql<number>`(SELECT COUNT(*) FROM chunks)`,
        totalEmbeddings: sql<number>`(SELECT COUNT(*) FROM embeddings)`
      })
      .from(documents)
      .limit(1);

    return json({
      documents: documentsWithChunks,
      stats: totalStats[0] || { totalDocuments: 0, totalChunks: 0, totalEmbeddings: 0 }
    });

  } catch (error) {
    console.error('Error getting documents:', error);
    return json({ error: 'Failed to get documents' }, { status: 500 });
  }
};
