<script lang="ts">
  import { onMount } from 'svelte';

  type Message = { id: string; role: 'user' | 'assistant'; content: string };

  export let title: string = 'AI Assistant';
  export let placeholder: string = 'Ask me anything...';

  let isOpen = false;
  let input = '';
  let loading = false;
  let error: string | null = null;
  let messages: Message[] = [];
  let fileInput: HTMLInputElement;
  let isUploading = false;
  let uploadProgress = '';

  function toggle() {
    isOpen = !isOpen;
    error = null;
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;
    input = '';
    error = null;

    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: text };
    messages = [...messages, userMsg];

    loading = true;
    try {
      // Validate messages before sending
      const validMessages = messages.filter(msg => 
        msg && 
        typeof msg === 'object' && 
        typeof msg.role === 'string' && 
        ['user', 'assistant', 'system'].includes(msg.role) &&
        typeof msg.content === 'string' && 
        msg.content.trim().length > 0
      );

      if (validMessages.length === 0) {
        throw new Error('No valid messages to send');
      }

      const res = await fetch('/api/chat/rag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: validMessages.map(({ role, content }) => ({ role, content })) })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to get response');
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let assistantText = '';
      
      // Add placeholder message for streaming
      const assistantId = crypto.randomUUID();
      messages = [
        ...messages,
        { id: assistantId, role: 'assistant', content: '' }
      ];

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('0:"')) {
              // Extract text between 0:" and "
              const match = line.match(/^0:"(.*)"/);
              if (match) {
                assistantText += match[1];
                // Update the message in real-time
                messages = messages.map(m => 
                  m.id === assistantId 
                    ? { ...m, content: assistantText }
                    : m
                );
              }
            }
          }
        }
      } else {
        assistantText = await res.text();
        messages = messages.map(m => 
          m.id === assistantId 
            ? { ...m, content: assistantText.trim() }
            : m
        );
      }
    } catch (e: any) {
      error = e?.message ?? 'Unknown error';
    } finally {
      loading = false;
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  async function handleFileUpload(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    
    if (!file) return;
    
    // Check file type
    if (!file.type.startsWith('text/') && !file.name.endsWith('.txt') && !file.name.endsWith('.md')) {
      error = 'Please upload a text file (.txt, .md) or a file with text content.';
      return;
    }
    
    // Check file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      error = 'File size must be less than 5MB.';
      return;
    }
    
    isUploading = true;
    uploadProgress = 'Reading file...';
    error = null;
    
    try {
      // Read file content
      const content = await file.text();
      uploadProgress = 'Processing document...';
      
      // Prepare document data
      const documentData = {
        title: file.name,
        content: content,
        source: `Uploaded: ${file.name}`,
        mimeType: file.type || 'text/plain'
      };
      
      uploadProgress = 'Ingesting document...';
      
      // Call ingestion API
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(documentData),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to ingest document');
      }
      
      const result = await response.json();
      
      // Add a system message to the chat about the uploaded document
      const systemMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `📄 **Document uploaded successfully!**\n\nI've ingested "${file.name}" with ${result.chunksCount} chunks. You can now ask me questions about this document.`
      };
      
      messages = [...messages, systemMsg];
      
      uploadProgress = 'Document ready!';
      
      // Clear the file input
      if (fileInput) {
        fileInput.value = '';
      }
      
      // Show success message briefly
      setTimeout(() => {
        uploadProgress = '';
      }, 2000);
      
    } catch (err: any) {
      error = err?.message || 'Failed to upload document';
      console.error('File upload error:', err);
    } finally {
      isUploading = false;
    }
  }

  function triggerFileUpload() {
    fileInput?.click();
  }
</script>

<style>
  .popup-shadow {
    box-shadow: 0 10px 25px rgba(0,0,0,0.15);
  }
</style>

<!-- Launcher Button -->
<button
  class="fixed bottom-4 right-4 z-50 rounded-full bg-indigo-600 text-white px-4 py-2 text-sm hover:bg-indigo-700 focus:outline-none cursor-pointer"
  on:click={toggle}
>
  {isOpen ? 'Close Chat' : 'Chat'}
</button>

{#if isOpen}
  <div class="fixed bottom-16 right-4 z-50 w-full max-w-sm rounded-xl bg-white popup-shadow border">
    <div class="flex items-center justify-between border-b px-4 py-3">
      <div class="font-semibold text-gray-800">{title}</div>
      <button class="text-gray-500 hover:text-gray-700 cursor-pointer" on:click={toggle}>✕</button>
    </div>

    <div class="h-72 overflow-y-auto px-4 py-3 space-y-3">
      {#if messages.length === 0}
        <div class="text-sm text-gray-500">Ask about your dashboard, settings, or features.</div>
      {/if}

      {#each messages as m}
        <div class={m.role === 'user' ? 'text-right' : 'text-left'}>
          <div class={m.role === 'user' ? 'inline-block rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm whitespace-pre-wrap' : 'inline-block rounded-lg bg-gray-100 text-gray-800 px-3 py-2 text-sm whitespace-pre-wrap'}>
            {m.content.replace(/\\n/g, '\n')}
          </div>
        </div>
      {/each}
    </div>

    {#if error}
      <div class="px-4 pb-2 text-xs text-red-600">{error}</div>
    {/if}

    <div class="border-t px-3 py-3">
      <div class="flex items-center gap-2">
        <textarea
          class="input min-h-[38px] h-[38px] w-full resize-none"
          rows={1}
          placeholder={placeholder}
          bind:value={input}
          on:keydown={onKeyDown}
        ></textarea>
        <div class="flex gap-1">
          <!-- File Upload Button -->
          <button
            class="btn btn-primary px-2 py-2 text-sm cursor-pointer bg-blue-600 hover:bg-blue-700"
            on:click={triggerFileUpload}
            disabled={isUploading || loading}
            title="Upload document"
          >
            📄
          </button>
          <button
            class="btn btn-primary px-3 py-2 text-sm cursor-pointer"
            on:click={sendMessage}
            disabled={loading}
          >
            {loading ? '...' : 'Send'}
          </button>
        </div>
      </div>
      
      <!-- Hidden file input -->
      <input
        type="file"
        bind:this={fileInput}
        on:change={handleFileUpload}
        accept=".txt,.md,text/*"
        style="display: none;"
      />
      
      <!-- Upload progress indicator -->
      {#if isUploading}
        <div class="mt-2 p-2 bg-blue-50 border border-blue-200 rounded text-blue-700 text-xs text-center">
          <div class="flex items-center justify-center gap-1">
            <svg class="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
            </svg>
            {uploadProgress}
          </div>
        </div>
      {/if}
      
      <div class="mt-1 text-[10px] text-gray-500">Press Enter to send • Click 📄 to upload</div>
    </div>
  </div>
{/if}


