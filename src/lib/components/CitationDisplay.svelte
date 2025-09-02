<script lang="ts">
  export let citations: Array<{
    document: string;
    similarity: string;
    chunkIndex: number;
    source: string;
  }> = [];
  
  export let showDetails = false;
  
  function toggleDetails() {
    showDetails = !showDetails;
  }
</script>

{#if citations.length > 0}
  <div class="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
    <div class="flex items-center justify-between mb-2">
      <h4 class="text-sm font-semibold text-blue-900 flex items-center gap-2">
        📚 Sources ({citations.length})
        <button 
          on:click={toggleDetails}
          class="text-xs text-blue-600 hover:text-blue-800 underline"
        >
          {showDetails ? 'Hide' : 'Show'} details
        </button>
      </h4>
    </div>
    
    <div class="space-y-2">
      {#each citations as citation, idx}
        <div class="text-sm">
          <div class="font-medium text-blue-800">
            {idx + 1}. {citation.document}
          </div>
          <div class="text-blue-600 text-xs">
            Similarity: {citation.similarity}
          </div>
          
          {#if showDetails}
            <div class="text-blue-600 text-xs mt-1">
              <div>Chunk #{citation.chunkIndex}</div>
              <div>Source: {citation.source}</div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
    
    <div class="mt-2 text-xs text-blue-600 italic">
      This response was informed by {citations.length} relevant document chunk{citations.length > 1 ? 's' : ''}.
    </div>
  </div>
{/if}
