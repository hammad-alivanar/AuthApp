import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { chat, message, chunks, embeddings, documents } from '$lib/server/db/schema';
import { eq, desc, sql, inArray } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { randomUUID } from 'crypto';

// Call embedding API for a single text
async function getEmbedding(text: string): Promise<number[]> {
  console.log(`🔍 Generating embedding for text: "${text.substring(0, 100)}..."`);
  
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
  console.log(`🔍 Generated embedding with ${data.embeddings[0]?.length || 0} dimensions`);
  return data.embeddings[0];
}

// Search for similar chunks using vector similarity with improved retrieval
async function searchSimilarChunks(queryEmbedding: number[], limit: number = 5) {
  const embeddingJson = JSON.stringify(queryEmbedding);
  
  console.log('🔍 Starting vector search...');
  console.log(`Query embedding length: ${queryEmbedding.length}`);
  
  try {
    // First, let's check if we have any chunks in the database
    const totalChunks = await db.select({ count: sql<number>`count(*)` }).from(chunks);
    const totalEmbeddings = await db.select({ count: sql<number>`count(*)` }).from(embeddings);
    const totalDocuments = await db.select({ count: sql<number>`count(*)` }).from(documents);
    
         console.log(`📊 Database stats: ${totalChunks[0]?.count || 0} chunks, ${totalEmbeddings[0]?.count || 0} embeddings, ${totalDocuments[0]?.count || 0} documents`);
     
     // Debug: Show all documents in database
     const allDocuments = await db.select({ title: documents.title, source: documents.source }).from(documents);
     console.log(`📚 All documents in database:`);
     allDocuments.forEach((doc, idx) => {
       console.log(`  ${idx + 1}. ${doc.title} (${doc.source})`);
     });
  
  // Use cosine similarity to find the most similar chunks
     // Increased limit to 8 to get more candidates, then filter by quality
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
       .limit(8); // Get more candidates for better filtering

     // Debug: Show what documents we found
     console.log(`🔍 Documents found in search results:`);
     const foundDocuments = [...new Set(similarChunks.map(c => c.documentTitle))];
     foundDocuments.forEach((doc, idx) => {
       const chunksForDoc = similarChunks.filter(c => c.documentTitle === doc);
       console.log(`  ${idx + 1}. ${doc}: ${chunksForDoc.length} chunks (similarity: ${chunksForDoc[0]?.similarity?.toFixed(3) || 'N/A'})`);
     });

    console.log(`🔍 Found ${similarChunks.length} similar chunks before filtering`);
    
    // Filter chunks by quality and diversity
    const filteredChunks = filterAndRankChunks(similarChunks, limit);
    console.log(`🔍 After filtering: ${filteredChunks.length} chunks`);
    
    return filteredChunks;
  } catch (error) {
    console.error('❌ Error in vector search:', error);
    throw error;
  }
}

// Filter and rank chunks for better retrieval quality
function filterAndRankChunks(chunks: any[], maxChunks: number = 5): any[] {
  console.log(`🔍 Filtering ${chunks.length} chunks...`);
  
  if (chunks.length === 0) return [];
  
  // Sort by similarity (highest first)
  const sortedChunks = [...chunks].sort((a, b) => b.similarity - a.similarity);
  console.log(`🔍 Similarity range: ${sortedChunks[0]?.similarity?.toFixed(3) || 'N/A'} - ${sortedChunks[sortedChunks.length-1]?.similarity?.toFixed(3) || 'N/A'}`);
  
  // Apply quality filters
  const qualityChunks = sortedChunks.filter(chunk => {
    // Minimum similarity threshold (20% - lowered for better retrieval)
    if (chunk.similarity < 0.2) {
      console.log(`🔍 Chunk filtered out: similarity ${chunk.similarity.toFixed(3)} < 0.2`);
      return false;
    }
    
    // Minimum content length (avoid very short chunks)
    if (chunk.content.length < 50) {
      console.log(`🔍 Chunk filtered out: content length ${chunk.content.length} < 50`);
      return false;
    }
    
    // Avoid chunks that are mostly whitespace or special characters
    const cleanContent = chunk.content.replace(/\s+/g, ' ').trim();
    if (cleanContent.length < 30) {
      console.log(`🔍 Chunk filtered out: clean content length ${cleanContent.length} < 30`);
      return false;
    }
    
    return true;
  });
  
  console.log(`🔍 After quality filtering: ${qualityChunks.length} chunks`);
  
  // Ensure diversity by limiting chunks from the same document
  const diverseChunks: any[] = [];
  const documentCounts: { [key: string]: number } = {};
  const maxChunksPerDocument = 2; // Limit chunks per document for diversity
  
  for (const chunk of qualityChunks) {
    const docId = chunk.documentId;
    if (!documentCounts[docId]) {
      documentCounts[docId] = 0;
    }
    
    if (documentCounts[docId] < maxChunksPerDocument) {
      diverseChunks.push(chunk);
      documentCounts[docId]++;
    }
    
    if (diverseChunks.length >= maxChunks) break;
  }
  
  return diverseChunks;
}

// Google Generative AI API integration with RAG
async function callGoogleGenerativeAIWithRAG(messages: any[], contextChunks: any[]): Promise<{ answer: string; citations: Array<{ id: number; source_doc: string; chunk_id: string; snippet: string; }> }> {
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('Google Generative AI API key not configured');

  // Build context from retrieved chunks with better formatting
  let contextText = '';
  if (contextChunks.length > 0) {
    contextText = '\n\n**📚 RELEVANT DOCUMENT CONTEXT (Use ONLY this information):**\n';
    contextChunks.forEach((chunk, idx) => {
      contextText += `\n**📄 Source ${idx + 1}: ${chunk.documentTitle}** (Similarity: ${(chunk.similarity * 100).toFixed(1)}%)\n`;
      contextText += `📍 Chunk #${chunk.idx} | Source: ${chunk.documentSource}\n`;
      contextText += `📝 Content:\n${chunk.content}\n`;
      contextText += `---\n`;
    });
    contextText += `\n**⚠️ CRITICAL INSTRUCTIONS:**\n`;
    contextText += `1) Base your response ONLY on the context above\n`;
    contextText += `2) Use inline numeric citations like [1], [2] where you use retrieved info\n`;
    contextText += `3) At the end, include a Citations section mapping each number to the document/chunk ID and a short snippet\n`;
    contextText += `4) Never invent facts; if unsupported by the context, say so\n`;
    contextText += `5) Rewrite in your own words; do not copy verbatim\n`;
    contextText += `6) Be concise but informative, similar to research-paper style citations\n`;
  }

  // Convert messages to Google's format
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));

  // Helper function to detect if a message is a simple greeting
  function isSimpleGreeting(message: string): boolean {
    const greetingPatterns = [
      /^hello\b/i,
      /^hi\b/i,
      /^hey\b/i,
      /^good\s*(morning|afternoon|evening|night)\b/i,
      /^how\s*are\s*you\b/i,
      /^what's\s*up\b/i,
      /^how's\s*it\s*going\b/i,
      /^nice\s*to\s*meet\s*you\b/i,
      /^pleasure\s*to\s*meet\s*you\b/i,
      /^thanks?\b/i,
      /^thank\s*you\b/i,
      /^bye\b/i,
      /^goodbye\b/i,
      /^see\s*you\b/i,
      /^take\s*care\b/i
    ];
    
    const cleanMessage = message.trim().toLowerCase();
    return greetingPatterns.some(pattern => pattern.test(cleanMessage));
  }

  // Helper function to detect if a message is asking for specific information
  function isSpecificQuestion(message: string): boolean {
    const questionPatterns = [
      /\b(what|how|why|when|where|which|who)\b/i,
      /\b(tell\s*me|explain|describe|list|show|give|provide)\b/i,
      /\b(different|various|types|kinds|sorts|examples)\b/i,
      /\b(current|latest|new|trend|trending|popular)\b/i,
      /\b(breed|breeds|technology|framework|language|tool)\b/i,
      /\b(compare|difference|similar|versus|vs)\b/i,
      /\b(tutorial|guide|steps|process|method)\b/i,
      /\b(problem|issue|error|bug|fix|solution)\b/i
    ];
    
    const cleanMessage = message.trim().toLowerCase();
    return questionPatterns.some(pattern => pattern.test(cleanMessage));
  }

  // Helper function to detect if a message is requesting a document summary
  function isDocumentSummaryRequest(message: string): boolean {
    const summaryPatterns = [
      /provide.*comprehensive.*summary/i,
      /document.*summary/i,
      /suggest.*questions/i,
      /key.*topics/i,
      /main.*content/i,
      /attached.*files/i,
      /document.*type/i
    ];
    
    const cleanMessage = message.trim().toLowerCase();
    
    // Check if this is a document summary request
    const isSummaryRequest = summaryPatterns.some(pattern => pattern.test(cleanMessage));
    
    // Additional check: if the message contains question words, it's likely NOT a summary request
    const questionWords = ['what', 'how', 'why', 'when', 'where', 'which', 'who', 'explain', 'describe', 'tell me', 'show me'];
    const hasQuestionWords = questionWords.some(word => cleanMessage.includes(word));
    
    // If it has question words, it's probably a specific question, not a summary request
    if (hasQuestionWords && !cleanMessage.includes('summary')) {
      return false;
    }
    
    return isSummaryRequest;
  }

  // Get the latest user message to determine response type
  const latestUserMessage = messages.filter(m => m.role === 'user').pop();
  const userMessage = latestUserMessage?.content || '';
  
  // Build system prompt based on whether we have context and message type
  let systemPromptText = '';
  
  if (contextChunks.length > 0) {
    // Check if this is a document summary request
    if (isDocumentSummaryRequest(userMessage)) {
      systemPromptText = `You are a helpful AI assistant that provides comprehensive document summaries and analysis. 

IMPORTANT: This is a document summary request. Provide a beautiful, well-formatted response in this EXACT structure with proper bullet point alignment:

**Your uploaded file describes [Document Title]: [Brief one-sentence description]. Here's a structured summary:**

**✅ Project Overview**
• Main goal: [Main goal/purpose of the document]
• Key objectives: [Key objectives and scope]
• Project scope: [Project scope and boundaries]

**✅ Key Requirements**
• Robust detection methods: [Major requirements or components]
• Scalability and efficiency: [Essential features and capabilities]
• Explainability: [Critical success factors]
• Ethical considerations: [Important considerations]

**✅ Technical Details**
• Forensic Analysis: [Important technical specifications]
• Metadata & Provenance: [Additional technical aspects]
• Machine Learning: [Technology stack or methodologies]
• Hybrid Approaches: [Combined methods]

**✅ Implementation Guidelines**
• Multi-faceted approach: [Process steps and methodologies]
• Integration strategy: [Implementation approach]
• Best practices: [Best practices and considerations]

**✅ Deliverables & Timeline**
• Research directions: [What needs to be delivered and when]
• Future work: [Key milestones]
• Implementation phases: [Project phases]

**✅ Additional Notes**
• Challenges: [Any other important information]
• Collaboration needs: [Extensions or special considerations]
• Future considerations: [Important caveats or limitations]

**Do you want me to:**
• **🔍 [Specific actionable suggestion 1]**
• **🔍 [Specific actionable suggestion 2]**
• **🔍 [Specific actionable suggestion 3]**
• **🔍 Or all of the above?**

**Suggested Questions:**
• [Question 1 about the document content]
• [Question 2 about specific aspects]
• [Question 3 about implementation]
• [Question 4 about technical details]
• [Question 5 about best practices]

IMPORTANT FORMATTING RULES:
- Use proper markdown formatting with **bold** for emphasis
- Use bullet points (•) for ALL lists within sections - EVERY section should have bullet points
- Use \`inline code\` for technical terms, commands, and file names
- Use \`\`\`language\ncode blocks\n\`\`\` for code examples
- Use > for blockquotes when explaining concepts
- Structure content with clear sections and proper spacing
- Make the response visually appealing and easy to read
- Use actual Unicode emojis (✅, 🔍, 💡, 🔧, ⚡, etc.)
- Ensure the response looks professional and polished
- ALWAYS use bullet points (•) for ALL content under each section heading
- Keep headings aligned and consistent throughout the response
- Each section should have at least 2-3 bullet points for proper formatting
- CRITICAL: All bullet points must be properly indented and aligned with consistent spacing
- Each bullet point should start with • and be followed by a space, then the content
- Maintain consistent left margin alignment for all bullet points within each section
- EXACT FORMAT: Each bullet point should follow the pattern "• Label: [content]" for consistency
- All bullet points must align perfectly with the heading text, not the emoji
- Use descriptive labels before the colon in each bullet point for better structure${contextText}`;
         } else {
               systemPromptText = `You are a helpful AI assistant with access to relevant documentation and context. 

CRITICAL ANTI-HALLUCINATION RULES:
1. **ONLY use information from the provided context** - if the answer is not in the context, say "I don't have enough information in my knowledge base to answer this question accurately."
2. **ALWAYS cite your sources** - when you use information from the context, cite it with superscript numbers
3. **Be explicit about limitations** - if the context doesn't contain enough information, acknowledge this
4. **Don't make assumptions** - stick to what's explicitly stated in the provided context

RESPONSE STYLE REQUIREMENTS:
1. **Answer naturally and conversationally** - like ChatGPT, not like a formal report
2. **Synthesize information** - don't just list facts, explain and connect ideas
3. **Use your own words** - rephrase the context in natural language
4. **Be engaging and helpful** - write as if you're having a conversation
5. **Avoid rigid formatting** - don't use numbered lists or bullet points unless specifically requested
6. **Flow naturally** - connect ideas with transitions and explanations

CITATION REQUIREMENTS:
1. When you use information from the provided context, cite it with superscript numbers like <sup>[1]</sup>, <sup>[2]</sup>, etc.
2. Use citations inline within your response when you reference specific information
3. Each citation should reference specific facts, data, or statements from the context
4. Do NOT include any raw data attributes or HTML tags in your response - only use <sup>[number]</sup> format
5. CRITICAL: Do NOT use ">" prefix before citations - just use <sup>[number]</sup> directly
6. CRITICAL: Do NOT output raw citation numbers like [1, 2, 3] - always wrap them in <sup> tags

FORMATTING GUIDELINES:
- Use **bold** for emphasis and important terms
- Use *italic* for code concepts and file names
- Use \`inline code\` for code snippets, variables, and commands
- Use \`\`\`language\ncode blocks\n\`\`\` for longer code examples
- Use > for blockquotes when referencing or explaining concepts
- Use [link text](url) for any relevant links
- Add emojis sparingly for visual appeal (💡, 🔧, ⚡, etc.)
- Use proper spacing and formatting for readability

EXAMPLE RESPONSE STYLE:
Instead of:
"1. Significant humanitarian crises: The conflict has repeatedly caused widespread suffering, including displacement of populations, loss of life, and destruction of infrastructure. [4]"

Write like:
"The conflict has had devastating humanitarian consequences, with widespread suffering affecting countless lives. Communities have been displaced, infrastructure destroyed, and the human toll has been immense<sup>[4]</sup>. This humanitarian crisis has created ripple effects throughout the region, with millions of people directly impacted by the ongoing violence and instability."

Make your responses natural, conversational, and engaging while being informative and well-cited.${contextText}`;
     }
  } else {
    // Check if this is a simple greeting or a specific question
    if (isSimpleGreeting(userMessage)) {
      systemPromptText = `You are a helpful AI programming assistant. 

Respond naturally to this greeting. Be friendly and conversational. Keep your response brief and welcoming.

IMPORTANT: Since this is just a greeting, do NOT include any citation sections or technical explanations.

Make your response warm and engaging.`;
    } else if (isSpecificQuestion(userMessage)) {
      systemPromptText = `You are a helpful AI programming assistant. 

I couldn't find relevant documents in my knowledge base to answer this question specifically, but I can help you with general programming knowledge and concepts.

IMPORTANT: Since I'm not using any specific documents for this response, do NOT include any citation sections.

FORMATTING GUIDELINES:
- Use **bold** for emphasis and important terms
- Use *italic* for code concepts and file names
- Use \`inline code\` for code snippets, variables, and commands
- Use \`\`\`language\ncode blocks\n\`\`\` for longer code examples
- Use # ## ### for headers to organize your responses
- Use - or * for bullet points in lists
- Use > for blockquotes when referencing or explaining concepts
- Use [link text](url) for any relevant links
- Structure your responses with clear sections using headers
- Add emojis for visual appeal (💡, 🔧, ⚡, 📝, 🚀, etc.)
- Use proper spacing and formatting for readability

Make your responses beautiful, well-formatted, and easy to read.`;
    } else {
      // For other general messages
      systemPromptText = `You are a helpful AI programming assistant. 

Respond naturally and helpfully to this message. Be conversational and engaging.

IMPORTANT: Since I'm not using any specific documents for this response, do NOT include any citation sections.

FORMATTING GUIDELINES:
- Use **bold** for emphasis and important terms
- Use *italic* for code concepts and file names
- Use \`inline code\` for code snippets, variables, and commands
- Use \`\`\`language\ncode blocks\n\`\`\` for longer code examples
- Use # ## ### for headers to organize your responses
- Use - or * for bullet points in lists
- Use > for blockquotes when referencing or explaining concepts
- Use [link text](url) for any relevant links
- Structure your responses with clear sections using headers
- Add emojis for visual appeal (💡, 🔧, ⚡, 📝, 🚀, etc.)
- Use proper spacing and formatting for readability

Make your response beautiful, well-formatted, and appropriate to the context and tone of the message.`;
    }
  }

  const systemPrompt = {
    role: 'user',
    parts: [{ text: systemPromptText }]
  };

  // Add system prompt at the beginning
  contents.unshift(systemPrompt);

  const body = {
    contents: contents,
    generationConfig: {
      temperature: 0.8, // Slightly higher for more natural responses
      topK: 40,
      topP: 0.95,
      maxOutputTokens: isDocumentSummaryRequest(userMessage) ? 2000 : 1200, // Slightly more tokens for natural responses
    },
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      }
    ]
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Google Generative AI API error: ${error.error?.message || response.statusText}`);
  }

  const data = await response.json();
  let aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, I couldn\'t generate a response.';
  
  // Return structured response with inline citations
  if (contextChunks.length > 0) {
    // Deduplicate citations by document and chunk
    const uniqueCitations = contextChunks.reduce((acc, chunk, idx) => {
      const key = `${chunk.documentTitle}-${chunk.idx}`;
      if (!acc.has(key)) {
        acc.set(key, {
          id: idx + 1,
          source_doc: chunk.documentTitle,
          chunk_id: `chunk_${chunk.idx}`,
          snippet: chunk.content.substring(0, 200) + (chunk.content.length > 200 ? '...' : '')
        });
      }
      return acc;
    }, new Map());
    
    const citations = Array.from(uniqueCitations.values()) as Array<{
      id: number;
      source_doc: string;
      chunk_id: string;
      snippet: string;
    }>;
    
    // Return AI response as-is to preserve formatting, plus citations array for UI
    return {
      answer: aiResponse,
      citations: citations
    };
  } else {
    // Only add polite message for specific questions, not simple greetings
    if (isSpecificQuestion(userMessage) && !isSimpleGreeting(userMessage)) {
      const noContextMessage = `\n\n---\n\n> **💡 Note**: I couldn't find relevant documents in my knowledge base for this question, so I'm providing general information based on my training data.`;
      return {
        answer: aiResponse + noContextMessage,
        citations: []
      };
    } else {
      // For simple greetings, just return the response without the note
      return {
        answer: aiResponse,
        citations: []
      };
    }
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    // Check if request has been aborted
    if (request.signal?.aborted) {
      return json({ error: 'Request was aborted' }, { status: 499 });
    }

    const session = await locals.auth();
    if (!session?.user?.id) {
      return json({ error: 'Unauthorized' }, { status: 401 });
    }

    let messages: any[] = [];
    let chatId: string | null = null;
    let documentIds: string[] = [];
    let summaryRequest = false;

    // Check content type and handle accordingly
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      // Handle form data (when file is uploaded)
      const formData = await request.formData();
      const messagesData = formData.get('messages');
      const docIds = formData.get('documentIds');
      const summaryFlag = formData.get('summaryRequest');
      
      if (!messagesData) {
        return json({ error: 'Missing messages' }, { status: 400 });
      }

      messages = JSON.parse(messagesData as string);
      if (docIds) {
        try { documentIds = JSON.parse(docIds as string) as string[]; } catch {}
      }
      if (summaryFlag) {
        summaryRequest = (summaryFlag as string) === 'true';
      }
      
      // Extract chatId from the first message if available
      if (messages.length > 0 && messages[0].chatId) {
        chatId = messages[0].chatId;
      }
    } else if (contentType.includes('application/json')) {
      // Handle JSON data
      const body = await request.json();
      messages = body.messages || [];
      documentIds = Array.isArray(body.documentIds) ? body.documentIds : [];
      summaryRequest = !!body.summaryRequest;
      
      // Extract chatId from the first message if available
      if (messages.length > 0 && messages[0].chatId) {
        chatId = messages[0].chatId;
      }
    } else {
      return json({ error: 'Unsupported content type. Use multipart/form-data or application/json' }, { status: 400 });
    }
    
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: 'Invalid messages format' }, { status: 400 });
    }

    // Update chat's updatedAt timestamp if we have a chatId
    if (chatId) {
      try {
        await db.update(chat).set({ updatedAt: new Date() }).where(eq(chat.id, chatId));
      } catch (error) {
        console.error('Error updating chat timestamp:', error);
        // Continue even if update fails
      }
    }

    // Get the latest user message for RAG
    const latestUserMessage = messages.filter(m => m.role === 'user').pop();
    let aiResponse = '';
    let contextChunks: any[] = [];
     let citations: Array<{ id: number; source_doc: string; chunk_id: string; snippet: string; }> = [];

    try {
      // Check if we have Google Generative AI API key and embedding API
      if (env.GOOGLE_GENERATIVE_AI_API_KEY && env.EMBEDDING_API_URL && latestUserMessage) {
        console.log('Using RAG with Google Generative AI API');
        
        if (summaryRequest && Array.isArray(documentIds) && documentIds.length > 0) {
          // Directly fetch chunks for provided document IDs for summarization
          console.log('🔎 Summary request detected. Fetching chunks by documentIds:', documentIds.length);
          // Fetch chunks for these documents directly
          contextChunks = await db
            .select({
              chunkId: chunks.id,
              content: chunks.content,
              idx: chunks.idx,
              documentId: chunks.documentId,
              documentTitle: documents.title,
              documentSource: documents.source,
              similarity: sql<number>`0.99`
            })
            .from(chunks)
            .innerJoin(documents, eq(chunks.documentId, documents.id))
            .where(inArray(chunks.documentId, documentIds))
            .limit(20);
        } else {
          // Generate embedding for the user's question and search
          const queryEmbedding = await getEmbedding(latestUserMessage.content);
          contextChunks = await searchSimilarChunks(queryEmbedding, 5);
        }
        
                 // Filter chunks by similarity threshold (20% minimum similarity for better retrieval)
         const SIMILARITY_THRESHOLD = 0.2; // 20% - lowered for better retrieval
        const relevantChunks = contextChunks.filter(chunk => chunk.similarity >= SIMILARITY_THRESHOLD);
        
        // Log the retrieved chunks for debugging
        console.log('🔍 RAG Debug - Retrieved Chunks:');
        contextChunks.forEach((chunk, idx) => {
          console.log(`  Chunk ${idx + 1}:`);
          console.log(`    Document: ${chunk.documentTitle}`);
          console.log(`    Similarity: ${(chunk.similarity * 100).toFixed(1)}%`);
          console.log(`    Chunk Index: ${chunk.idx}`);
          console.log(`    Source: ${chunk.documentSource}`);
          console.log(`    Content: ${chunk.content.substring(0, 100)}...`);
          console.log(`    Relevant: ${chunk.similarity >= SIMILARITY_THRESHOLD ? '✅' : '❌'}`);
        });
        
        console.log('📚 Citation Summary:');
        console.log(`  Total chunks found: ${contextChunks.length}`);
        console.log(`  Relevant chunks (≥${SIMILARITY_THRESHOLD * 100}%): ${relevantChunks.length}`);
        console.log(`  Documents: ${[...new Set(contextChunks.map(c => c.documentTitle))].join(', ')}`);
        console.log(`  Similarity range: ${(Math.min(...contextChunks.map(c => c.similarity)) * 100).toFixed(1)}% - ${(Math.max(...contextChunks.map(c => c.similarity)) * 100).toFixed(1)}%`);
        console.log(`  🔍 Documents in search: ${[...new Set(contextChunks.map(c => c.documentTitle))].length} unique documents`);
        console.log(`  📄 Document breakdown:`);
        const docCounts = contextChunks.reduce((acc, chunk) => {
          acc[chunk.documentTitle] = (acc[chunk.documentTitle] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        Object.entries(docCounts).forEach(([doc, count]) => {
          console.log(`    - ${doc}: ${count} chunks`);
        });
        
        // Use RAG-enhanced AI response only if we have relevant chunks
        if (relevantChunks.length > 0) {
          console.log('✅ Using RAG with relevant document context');
          console.log(`🔍 Sending ${relevantChunks.length} chunks to AI with context`);
          const result = await callGoogleGenerativeAIWithRAG(messages, relevantChunks);
          aiResponse = result.answer;
          citations = result.citations;
          
          // Validate that we got a proper RAG response
          if (aiResponse.includes("I don't have enough information") && relevantChunks.length > 0) {
            console.log('⚠️ AI gave fallback response despite having context - forcing RAG response');
            // Force a better response by being more explicit
            const forcedResult = await callGoogleGenerativeAIWithRAG(messages, relevantChunks);
            aiResponse = forcedResult.answer;
            citations = forcedResult.citations;
          }
        } else {
          console.log('❌ No relevant documents found, using general knowledge');
           const result = await callGoogleGenerativeAIWithRAG(messages, []);
           aiResponse = result.answer;
           citations = result.citations;
        }
      } else if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
        console.log('Using Google Generative AI API without RAG');
        // Use Google Generative AI API without RAG
         const result = await callGoogleGenerativeAIWithRAG(messages, []);
         aiResponse = result.answer;
         citations = result.citations;
      } else {
        console.log('No Google Generative AI API key found, using basic responses');
        // Fall back to basic responses
        aiResponse = generateBasicResponse(messages);
         citations = [];
      }
    } catch (error) {
      console.error('AI API error:', error);
      // Fall back to basic response on error
      aiResponse = generateBasicResponse(messages);
    }

    // Create a streaming response
    const stream = new ReadableStream({
      start(controller) {
        // Simulate streaming by sending the response in chunks
        const words = aiResponse.split(' ');
        let index = 0;
        let isAborted = false;
        
        const sendChunk = () => {
          // Check if the stream has been aborted
          if (isAborted || index >= words.length) {
            try {
               // Send final data with citations
               const finalData = {
                 type: 'complete',
                 citations: citations
               };
               controller.enqueue(new TextEncoder().encode(`1:${JSON.stringify(finalData)}\n`));
              controller.close();
            } catch (e) {
              // Ignore errors when closing an already closed controller
            }
            return;
          }
          
          try {
            const chunk = words[index] + ' ';
            controller.enqueue(new TextEncoder().encode(`0:${JSON.stringify(chunk)}\n`));
            index++;
            
            // Check if we should continue or if request was aborted
            if (index < words.length) {
              setTimeout(sendChunk, 100); // Simulate typing delay
            } else {
              try {
                 // Send final data with citations
                 const finalData = {
                   type: 'complete',
                   citations: citations
                 };
                 controller.enqueue(new TextEncoder().encode(`1:${JSON.stringify(finalData)}\n`));
                controller.close();
              } catch (e) {
                // Ignore errors when closing an already closed controller
              }
            }
          } catch (error) {
            // If enqueue fails (stream closed), stop sending chunks
            console.log('Stream closed, stopping chunks');
            isAborted = true;
            try {
              controller.close();
            } catch (e) {
              // Ignore errors when closing an already closed controller
            }
          }
        };
        
        sendChunk();
        
        // Handle stream cancellation
        return () => {
          isAborted = true;
        };
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });

  } catch (error) {
    console.error('Error in RAG chat API:', error);
    return json({ error: 'Failed to process chat request' }, { status: 500 });
  }
};

// Fallback basic response generator
function generateBasicResponse(messages: any[]): string {
  const userMessage = messages.find(m => m.role === 'user');
  if (!userMessage) return 'I received your message. How can I help you?';

  const userQuery = userMessage.content.toLowerCase().trim();
  
  return `# I Understand Your Question

You're asking about: **"${userMessage.content}"**

## Current Status
I'm currently using **basic responses** since no AI API is configured. To get **intelligent, contextual responses with RAG**, please add these environment variables:

\`\`\`bash
GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key
EMBEDDING_API_URL=http://embed-api:8000
\`\`\`

## What I Can Still Help With
Even without the AI API, I can assist with:
- **Basic programming concepts**
- **Code examples** and templates
- **Algorithm explanations**
- **Language-specific syntax**
- **Common programming patterns**

## Next Steps
1. **Get a Google AI API key** from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. **Start the embedding API** with Docker Compose
3. **Add the environment variables**
4. **Restart your application**

> **In the meantime**: What specific programming help do you need? I'll do my best to assist you!`;
}
