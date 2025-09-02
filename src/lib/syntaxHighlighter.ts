import { getHighlighter, type Highlighter } from 'shiki';

let highlighter: Highlighter | null = null;

// Initialize the highlighter with common languages and themes
export async function initHighlighter(): Promise<Highlighter> {
  if (highlighter) {
    return highlighter;
  }

  try {
    highlighter = await getHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [
        'javascript',
        'typescript',
        'python',
        'java',
        'html',
        'css',
        'json',
        'markdown',
        'sql',
        'bash',
        'shell',
        'yaml',
        'xml',
        'php',
        'ruby',
        'go',
        'rust',
        'cpp',
        'c',
        'csharp',
        'svelte'
      ]
    });

    return highlighter;
  } catch (error) {
    console.error('Failed to initialize syntax highlighter:', error);
    throw error;
  }
}

// Highlight code with the specified language
export async function highlightCode(code: string, language: string = 'text'): Promise<string> {
  try {
    const hl = await initHighlighter();
    
    // Map some common language aliases to their proper names
    const languageMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'sh': 'bash',
      'yml': 'yaml'
    };

    const normalizedLang = languageMap[language.toLowerCase()] || language.toLowerCase();
    
    // Check if the language is supported
    const supportedLangs = hl.getLoadedLanguages();
    const finalLang = supportedLangs.includes(normalizedLang) ? normalizedLang : 'text';
    


    return hl.codeToHtml(code, {
      lang: finalLang,
      theme: 'github-dark',
      transformers: [],
      meta: {
        style: 'white-space: pre; overflow-x: auto;'
      }
    });
  } catch (error) {
    console.error('Failed to highlight code:', error);
    // Fallback to plain code block
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

// Escape HTML characters
function escapeHtml(text: string): string {
  if (typeof document === 'undefined') {
    // Server-side fallback
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Clean up the highlighter when needed
export function disposeHighlighter(): void {
  if (highlighter) {
    highlighter.dispose();
    highlighter = null;
  }
}
