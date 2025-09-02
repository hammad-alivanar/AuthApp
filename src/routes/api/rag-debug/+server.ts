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

    console.log('🔍 RAG Debug - Processing question:', question);

    // Generate embedding for the question
    const queryEmbedding = await getEmbedding(question);
    
    // Search for similar chunks
    const similarChunks = await searchSimilarChunks(queryEmbedding, 5);

    // Return detailed debug information
    const result = {
      question,
      queryEmbedding: {
        dimensions: queryEmbedding.length,
        sample: queryEmbedding.slice(0, 5)
      },
      retrievedChunks: similarChunks.map(chunk => ({
        chunkId: chunk.chunkId,
        content: chunk.content,
        documentTitle: chunk.documentTitle,
        documentSource: chunk.documentSource,
        similarity: chunk.similarity,
        chunkIndex: chunk.idx,
        similarityPercentage: (chunk.similarity * 100).toFixed(1) + '%'
      })),
      summary: {
        totalChunksFound: similarChunks.length,
        averageSimilarity: similarChunks.length > 0 
          ? similarChunks.reduce((sum, chunk) => sum + chunk.similarity, 0) / similarChunks.length 
          : 0,
        hasRelevantContent: similarChunks.length > 0 && similarChunks[0].similarity > 0.5,
        documentsReferenced: [...new Set(similarChunks.map(c => c.documentTitle))]
      }
    };

    return json(result);

  } catch (error) {
    console.error('❌ Error in RAG debug:', error);
    return json({ 
      error: 'Failed to process RAG debug',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
};
