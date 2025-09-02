import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { chat, chunks, embeddings, documents } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';

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
    let uploadedFile: File | null = null;

    // Check content type and handle accordingly
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      // Handle form data (when file is uploaded)
      const formData = await request.formData();
      const messagesData = formData.get('messages');
      uploadedFile = formData.get('file') as File || null;
      
      if (!messagesData) {
        return json({ error: 'Missing messages' }, { status: 400 });
      }

      messages = JSON.parse(messagesData as string);
      
      // Extract chatId from the first message if available
      if (messages.length > 0 && messages[0].chatId) {
        chatId = messages[0].chatId;
      }
    } else if (contentType.includes('application/json')) {
      // Handle JSON data
      const body = await request.json();
      messages = body.messages || [];
      
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

    // Try to use AI API if available, otherwise fall back to basic responses
    let aiResponse = '';
    
    try {
      // Check if we have Google Generative AI API key
      if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
        console.log('Using Google Generative AI API');
        // Use Google Generative AI API
        aiResponse = await callGoogleGenerativeAI(messages, uploadedFile);
        } else {
        console.log('No Google Generative AI API key found, using basic responses');
        // Fall back to basic responses
        aiResponse = generateBasicResponse(messages);
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
    console.error('Error in chat API:', error);
    return json({ error: 'Failed to process chat request' }, { status: 500 });
  }
};

// Google Generative AI API integration
async function callGoogleGenerativeAI(messages: any[], file: File | null): Promise<string> {
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error('Google Generative AI API key not configured');

  // Convert messages to Google's format
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));

  // Add system prompt to ensure markdown formatting
  const systemPrompt = {
    role: 'user',
    parts: [{ text: `You are a helpful AI programming assistant. Format your responses using markdown:

- Use **bold** for emphasis and important terms
- Use *italic* for code concepts and file names
- Use \`inline code\` for code snippets, variables, and commands
- Use \`\`\`language\ncode blocks\n\`\`\` for code examples
- Use # ## for headers when organizing content
- Use - for bullet points and lists
- Provide complete, working code examples when requested
- Be thorough but organized in your responses

When asked for code examples, provide complete, functional implementations with proper syntax highlighting.` }]
  };

  // Add file context if available
  if (file) {
    contents.unshift({
      role: 'user',
      parts: [{ text: `I have uploaded a file: ${file.name}. Please consider this context when responding.` }]
    });
  }

  // Add system prompt at the beginning
  contents.unshift(systemPrompt);

  const body = {
    contents: contents,
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048, // Increased for longer code responses
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
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, I couldn\'t generate a response.';
}

// Fallback basic response generator
function generateBasicResponse(messages: any[]): string {
  const userMessage = messages.find(m => m.role === 'user');
  if (!userMessage) return 'I received your message. How can I help you?';

  const userQuery = userMessage.content.toLowerCase().trim();
  
  // Handle specific programming questions with SHORT responses
  if (userQuery.includes('swap') && userQuery.includes('cpp')) {
    return `**C++ Variable Swapping:**

\`\`\`cpp
void swap(int &a, int &b) {
    int temp = a;
    a = b;
    b = temp;
}
\`\`\`

Use **temporary variable** for clarity or **std::swap()** for modern C++.`;
  } else if (userQuery === 'hi' || userQuery === 'hello' || userQuery.includes('hi') || userQuery.includes('hello')) {
    return `**Hello! 👋** I'm your AI programming assistant. Ask me any coding question!`;
  } else if (userQuery.includes('help')) {
    return `**I can help with:** Code generation, debugging, explanations, best practices, and code reviews. What do you need?`;
  } else {
    return `**No AI API configured.** Add \`GOOGLE_GENERATIVE_AI_API_KEY\` to get intelligent responses. I can still help with basic programming questions!`;
  }
}


