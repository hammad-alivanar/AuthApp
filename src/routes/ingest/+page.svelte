<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import type { PageData } from './$types';

  export let data: PageData;

  let title = '';
  let content = '';
  let source = '';
  let mimeType = 'text/plain';
  let isSubmitting = false;
  let message = '';
  let messageType: 'success' | 'error' = 'success';

  onMount(() => {
    if (!data.user) {
      goto('/login');
    }
  });

  async function handleSubmit() {
    if (!title.trim() || !content.trim() || !source.trim()) {
      message = 'Please fill in all required fields';
      messageType = 'error';
      return;
    }

    isSubmitting = true;
    message = '';

    try {
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: title.trim(),
          content: content.trim(),
          source: source.trim(),
          mimeType,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        message = result.message;
        messageType = 'success';
        // Clear form on success
        title = '';
        content = '';
        source = '';
        mimeType = 'text/plain';
      } else {
        message = result.error || 'Failed to ingest document';
        messageType = 'error';
      }
    } catch (error) {
      message = 'Network error occurred';
      messageType = 'error';
    } finally {
      isSubmitting = false;
    }
  }
</script>

<svelte:head>
  <title>Ingest Document - RAG System</title>
</svelte:head>

<div class="min-h-screen bg-gray-50 py-8">
  <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="bg-white shadow rounded-lg p-6">
      <div class="mb-8">
        <h1 class="text-3xl font-bold text-gray-900 mb-2">Ingest Document</h1>
        <p class="text-gray-600">
          Add documents to your RAG system for enhanced AI responses with context.
        </p>
      </div>

      {#if message}
        <div class="mb-6 p-4 rounded-md {messageType === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}">
          {message}
        </div>
      {/if}

      <form on:submit|preventDefault={handleSubmit} class="space-y-6">
        <div>
          <label for="title" class="block text-sm font-medium text-gray-700 mb-2">
            Document Title *
          </label>
          <input
            type="text"
            id="title"
            bind:value={title}
            required
            class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Enter document title"
          />
        </div>

        <div>
          <label for="source" class="block text-sm font-medium text-gray-700 mb-2">
            Source *
          </label>
          <input
            type="text"
            id="source"
            bind:value={source}
            required
            class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="e.g., API Documentation, User Manual, etc."
          />
        </div>

        <div>
          <label for="mimeType" class="block text-sm font-medium text-gray-700 mb-2">
            MIME Type
          </label>
          <select
            id="mimeType"
            bind:value={mimeType}
            class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="text/plain">Text/Plain</option>
            <option value="text/markdown">Text/Markdown</option>
            <option value="application/json">Application/JSON</option>
            <option value="text/html">Text/HTML</option>
          </select>
        </div>

        <div>
          <label for="content" class="block text-sm font-medium text-gray-700 mb-2">
            Document Content *
          </label>
          <textarea
            id="content"
            bind:value={content}
            required
            rows="12"
            class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Paste your document content here..."
          ></textarea>
          <p class="mt-1 text-sm text-gray-500">
            The content will be automatically split into chunks and embedded for semantic search.
          </p>
        </div>

        <div class="flex items-center justify-between">
          <button
            type="button"
            on:click={() => goto('/chat')}
            class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Back to Chat
          </button>
          
          <button
            type="submit"
            disabled={isSubmitting}
            class="px-6 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Ingesting...' : 'Ingest Document'}
          </button>
        </div>
      </form>

      <div class="mt-8 p-4 bg-blue-50 rounded-md">
        <h3 class="text-sm font-medium text-blue-800 mb-2">How it works:</h3>
        <ul class="text-sm text-blue-700 space-y-1">
          <li>• Your document will be split into smaller chunks for better retrieval</li>
          <li>• Each chunk will be converted to a vector embedding using local AI models</li>
          <li>• When you ask questions in chat, the system will find the most relevant chunks</li>
          <li>• The AI will use this context to provide more accurate and detailed responses</li>
        </ul>
      </div>
    </div>
  </div>
</div>
