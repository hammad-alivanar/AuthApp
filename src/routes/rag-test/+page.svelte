<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';

  export let data: PageData;

  let question = '';
  let isSubmitting = false;
  let result: any = null;
  let error = '';
  let documents: any[] = [];
  let stats: any = {};

  onMount(() => {
    if (!data.user) {
      goto('/login');
    }
    loadDocuments();
  });

  async function loadDocuments() {
    try {
      const response = await fetch('/api/rag-test');
      if (response.ok) {
        const data = await response.json();
        documents = data.documents;
        stats = data.stats;
      }
    } catch (err) {
      console.error('Failed to load documents:', err);
    }
  }

  async function testRAG() {
    if (!question.trim()) return;

    isSubmitting = true;
    error = '';
    result = null;

    try {
      const response = await fetch('/api/rag-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ question: question.trim() }),
      });

      if (response.ok) {
        result = await response.json();
      } else {
        const errorData = await response.json();
        error = errorData.error || 'Failed to test RAG';
      }
    } catch (err) {
      error = 'Network error occurred';
    } finally {
      isSubmitting = false;
    }
  }
</script>

<svelte:head>
  <title>RAG Test - Vector Search</title>
</svelte:head>

<div class="min-h-screen bg-gray-50 py-8">
  <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="mb-8">
      <h1 class="text-3xl font-bold text-gray-900 mb-2">RAG Pipeline Test</h1>
      <p class="text-gray-600">
        Test the core RAG functionality: Question → Embedding → Vector Search → Retrieved Chunks
      </p>
    </div>

    <!-- Stats Overview -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
      <div class="bg-white p-6 rounded-lg shadow">
        <h3 class="text-lg font-semibold text-gray-900">Documents</h3>
        <p class="text-3xl font-bold text-blue-600">{stats.totalDocuments || 0}</p>
      </div>
      <div class="bg-white p-6 rounded-lg shadow">
        <h3 class="text-lg font-semibold text-gray-900">Chunks</h3>
        <p class="text-3xl font-bold text-green-600">{stats.totalChunks || 0}</p>
      </div>
      <div class="bg-white p-6 rounded-lg shadow">
        <h3 class="text-lg font-semibold text-gray-900">Embeddings</h3>
        <p class="text-3xl font-bold text-purple-600">{stats.totalEmbeddings || 0}</p>
      </div>
    </div>

    <!-- Test Form -->
    <div class="bg-white shadow rounded-lg p-6 mb-8">
      <h2 class="text-xl font-semibold text-gray-900 mb-4">Test Vector Search</h2>
      
      <div class="space-y-4">
        <div>
          <label for="question" class="block text-sm font-medium text-gray-700 mb-2">
            Ask a question about your ingested documents:
          </label>
          <input
            type="text"
            id="question"
            bind:value={question}
            placeholder="e.g., What is SvelteKit? How do I create a new project?"
            class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            on:keydown={(e) => e.key === 'Enter' && testRAG()}
          />
        </div>
        
        <button
          on:click={testRAG}
          disabled={isSubmitting || !question.trim()}
          class="px-6 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? 'Testing...' : 'Test RAG Pipeline'}
        </button>
      </div>
    </div>

    <!-- Results -->
    {#if error}
      <div class="bg-red-50 border border-red-200 rounded-md p-4 mb-8">
        <div class="text-red-800">
          <strong>Error:</strong> {error}
        </div>
      </div>
    {/if}

    {#if result}
      <div class="bg-white shadow rounded-lg p-6 mb-8">
        <h2 class="text-xl font-semibold text-gray-900 mb-4">RAG Test Results</h2>
        
        <!-- Question and Summary -->
        <div class="mb-6">
          <h3 class="text-lg font-medium text-gray-900 mb-2">Question</h3>
          <p class="text-gray-700 bg-gray-50 p-3 rounded">{result.question}</p>
        </div>

                 <!-- Summary Stats -->
         <div class="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
           <div class="bg-blue-50 p-4 rounded-lg">
             <h4 class="font-medium text-blue-900">Total Chunks</h4>
             <p class="text-2xl font-bold text-blue-600">{result.summary.totalChunksFound}</p>
           </div>
           <div class="bg-green-50 p-4 rounded-lg">
             <h4 class="font-medium text-green-900">Relevant Chunks</h4>
             <p class="text-2xl font-bold text-green-600">{result.summary.relevantChunksFound}</p>
           </div>
           <div class="bg-purple-50 p-4 rounded-lg">
             <h4 class="font-medium text-purple-900">Threshold</h4>
             <p class="text-2xl font-bold text-purple-600">{result.summary.similarityThreshold}</p>
           </div>
           <div class="bg-orange-50 p-4 rounded-lg">
             <h4 class="font-medium text-orange-900">Documents</h4>
             <p class="text-2xl font-bold text-orange-600">{result.summary.documentsReferenced.length}</p>
           </div>
           <div class="bg-red-50 p-4 rounded-lg">
             <h4 class="font-medium text-red-900">Has Relevant</h4>
             <p class="text-2xl font-bold text-red-600">{result.summary.hasRelevantContent ? 'Yes' : 'No'}</p>
           </div>
         </div>
        
        <!-- Similarity Range -->
        {#if result.summary.similarityRange}
          <div class="bg-gray-50 p-4 rounded-lg mb-6">
            <h4 class="font-medium text-gray-900 mb-2">Similarity Range</h4>
            <p class="text-lg font-semibold text-gray-700">
              {result.summary.similarityRange.min} - {result.summary.similarityRange.max}
            </p>
          </div>
        {/if}

        <!-- Retrieved Chunks -->
        <div>
          <h3 class="text-lg font-medium text-gray-900 mb-4">Retrieved Chunks</h3>
          {#if result.retrievedChunks.length === 0}
            <p class="text-gray-500">No relevant chunks found. Try ingesting some documents first.</p>
          {:else}
            <div class="space-y-4">
              {#each result.retrievedChunks as chunk, index}
                <div class="border border-gray-200 rounded-lg p-4">
                  <div class="flex justify-between items-start mb-2">
                    <div>
                      <h4 class="font-medium text-gray-900">
                        Source: {chunk.documentTitle}
                      </h4>
                      <p class="text-sm text-gray-500">
                        Chunk #{chunk.chunkIndex} • Similarity: {chunk.similarityPercentage}
                      </p>
                    </div>
                                         <div class="flex gap-1">
                       <span class="bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5 rounded">
                         Rank #{index + 1}
                       </span>
                       {#if chunk.isRelevant}
                         <span class="bg-green-100 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded">
                           ✅ Relevant
                         </span>
                       {:else}
                         <span class="bg-gray-100 text-gray-800 text-xs font-medium px-2.5 py-0.5 rounded">
                           ❌ Below Threshold
                         </span>
                       {/if}
                     </div>
                  </div>
                  <div class="bg-gray-50 p-3 rounded text-sm text-gray-700">
                    {chunk.content}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Available Documents -->
    <div class="bg-white shadow rounded-lg p-6">
      <h2 class="text-xl font-semibold text-gray-900 mb-4">Available Documents</h2>
      
      {#if documents.length === 0}
        <p class="text-gray-500">No documents ingested yet. 
          <a href="/ingest" class="text-blue-600 hover:text-blue-800 underline">Ingest a document</a> to test RAG.
        </p>
      {:else}
        <div class="space-y-3">
          {#each documents as doc}
            <div class="flex justify-between items-center p-3 border border-gray-200 rounded-lg">
              <div>
                <h3 class="font-medium text-gray-900">{doc.title}</h3>
                <p class="text-sm text-gray-500">Source: {doc.source}</p>
                <p class="text-xs text-gray-400">
                  Created: {new Date(doc.createdAt).toLocaleDateString()}
                </p>
              </div>
              <span class="bg-green-100 text-green-800 text-xs font-medium px-2.5 py-0.5 rounded">
                {doc.chunkCount} chunks
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
