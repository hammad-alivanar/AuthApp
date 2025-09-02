# RAG (Retrieval-Augmented Generation) System

This document explains how to set up and use the RAG system that has been integrated into your SvelteKit + Postgres application.

## Overview

The RAG system enhances your AI chat by:
1. **Storing documents** in a vector database with semantic embeddings
2. **Retrieving relevant context** when users ask questions
3. **Providing AI responses** with citations from your knowledge base

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   SvelteKit     │    │  Python Embed   │    │  pgvector DB    │
│   Frontend      │◄──►│     API         │◄──►│   (Postgres)    │
│                 │    │   (FastAPI)     │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## Setup Instructions

### 1. Environment Variables

Copy the example environment file and configure it:

```bash
cp env.example .env
```

Add these variables to your `.env`:

```bash
# Database (updated for pgvector)
DATABASE_URL=postgres://root:mysecretpassword@localhost:5432/local

# Embedding API
EMBEDDING_API_URL=http://localhost:8000

# Google AI (optional - for enhanced responses)
GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key_here
```

### 2. Start the Services

```bash
# Start all services (Postgres + Embedding API)
docker compose up -d

# Install dependencies
pnpm install

# Push database schema
pnpm db:push

# Start the development server
pnpm dev
```

### 3. Verify Setup

1. **Check Database**: Visit `http://localhost:5432` (pgAdmin or similar)
2. **Check Embedding API**: Visit `http://localhost:8000/health`
3. **Check SvelteKit App**: Visit `http://localhost:5173`

## Usage

### 1. Ingest Documents

1. Navigate to `/ingest` in your application
2. Fill in the form:
   - **Title**: Document name
   - **Source**: Where the document came from
   - **Content**: The actual text content
3. Click "Ingest Document"

The system will:
- Split your document into chunks (~1000 characters each)
- Generate embeddings for each chunk using local AI models
- Store everything in the vector database

### 2. Chat with RAG

1. Navigate to `/chat` in your application
2. Ask questions about your ingested documents
3. The AI will:
   - Convert your question to an embedding
   - Find the most similar document chunks
   - Include relevant context in the response
   - Cite the source documents

## API Endpoints

### Ingestion API
```http
POST /api/ingest
Content-Type: application/json

{
  "title": "Document Title",
  "content": "Document content...",
  "source": "Source description",
  "mimeType": "text/plain"
}
```

### RAG Chat API
```http
POST /api/chat/rag
Content-Type: application/json

{
  "messages": [
    {
      "role": "user",
      "content": "Your question here"
    }
  ]
}
```

## Database Schema

### Documents Table
```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  mime_type TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Chunks Table
```sql
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  idx INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Embeddings Table
```sql
CREATE TABLE embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id),
  embedding vector(384)
);
```

## Technical Details

### Embedding Model
- **Model**: `sentence-transformers/all-MiniLM-L6-v2`
- **Dimensions**: 384
- **Type**: Local (no API calls needed)

### Chunking Strategy
- **Chunk Size**: ~1000 characters
- **Overlap**: 200 characters
- **Break Points**: Sentence boundaries (periods, newlines)

### Similarity Search
- **Method**: Cosine similarity
- **Index**: IVFFLAT with 100 lists
- **Results**: Top 3-5 most similar chunks

### AI Integration
- **Provider**: Google Generative AI (Gemini)
- **Model**: gemini-1.5-flash
- **Context**: Retrieved chunks included in system prompt
- **Citations**: Document titles mentioned in responses

## Troubleshooting

### Embedding API Issues
```bash
# Check if the service is running
docker compose ps

# View logs
docker compose logs embed-api

# Restart the service
docker compose restart embed-api
```

### Database Issues
```bash
# Check database connection
pnpm db:check

# Reset database (WARNING: deletes all data)
docker compose down -v
docker compose up -d
pnpm db:push
```

### Vector Search Issues
```sql
-- Check if pgvector extension is enabled
SELECT * FROM pg_extension WHERE extname = 'vector';

-- Check embeddings table
SELECT COUNT(*) FROM embeddings;

-- Test similarity search
SELECT chunk_id, 1 - (embedding <=> '[0.1, 0.2, ...]'::vector) as similarity 
FROM embeddings 
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector 
LIMIT 5;
```

## Performance Considerations

### Embedding API
- **Memory**: ~2GB RAM for the model
- **CPU**: Single-threaded inference
- **Latency**: ~100-500ms per embedding

### Database
- **Storage**: ~1KB per embedding (384 floats)
- **Index**: IVFFLAT for fast similarity search
- **Scaling**: Consider HNSW index for large datasets

### Recommendations
- **Batch Processing**: Process multiple documents at once
- **Caching**: Cache frequently accessed embeddings
- **Monitoring**: Watch memory usage of embedding API

## Security Notes

1. **Authentication**: All endpoints require user authentication
2. **Input Validation**: Content is sanitized before processing
3. **Rate Limiting**: Consider adding rate limits for production
4. **Data Privacy**: Embeddings are stored locally, no external API calls

## Future Enhancements

- [ ] File upload support (PDF, DOCX, etc.)
- [ ] Advanced chunking strategies
- [ ] Multiple embedding models
- [ ] Semantic search interface
- [ ] Document versioning
- [ ] Access control per document
- [ ] Analytics and usage tracking
