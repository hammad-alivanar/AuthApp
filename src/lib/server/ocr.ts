import { ImageAnnotatorClient } from '@google-cloud/vision';
import { env } from '$env/dynamic/private';

// Initialize Google Cloud Vision client
let visionClient: ImageAnnotatorClient | null = null;

function getVisionClient(): ImageAnnotatorClient {
  if (!visionClient) {
    if (!env.GOOGLE_CLOUD_CREDENTIALS) {
      throw new Error('GOOGLE_CLOUD_CREDENTIALS environment variable not set');
    }
    
    visionClient = new ImageAnnotatorClient({
      credentials: JSON.parse(env.GOOGLE_CLOUD_CREDENTIALS)
    });
  }
  return visionClient;
}

// Extract text from PDF using OCR
export async function extractTextFromPDFWithOCR(pdfBuffer: Buffer): Promise<string> {
  try {
    const client = getVisionClient();
    
    // Convert PDF to images and extract text from each page
    const request = {
      inputConfig: {
        gcsSource: {
          uri: `gs://your-bucket/${Date.now()}.pdf` // You'll need to upload to GCS first
        },
        mimeType: 'application/pdf'
      },
      features: [
        {
          type: 'DOCUMENT_TEXT_DETECTION' as const
        }
      ]
    };

    const [result] = await client.batchAnnotateFiles({
      requests: [request]
    });

    const responses = result.responses || [];
    let extractedText = '';

    for (const response of responses) {
      if (response.fullTextAnnotation) {
        extractedText += response.fullTextAnnotation.text + '\n';
      }
    }

    return extractedText.trim();
  } catch (error) {
    console.error('OCR extraction failed:', error);
    throw new Error('Failed to extract text from image-based PDF using OCR');
  }
}

// Alternative: Extract text from individual images
export async function extractTextFromImage(imageBuffer: Buffer): Promise<string> {
  try {
    const client = getVisionClient();
    
    const request = {
      image: {
        content: imageBuffer.toString('base64')
      },
      features: [
        {
          type: 'DOCUMENT_TEXT_DETECTION' as const
        }
      ]
    };

    const [result] = await client.annotateImage(request);
    const textAnnotations = result.textAnnotations || [];
    
    if (textAnnotations.length > 0) {
      return textAnnotations[0].description || '';
    }
    
    return '';
  } catch (error) {
    console.error('Image OCR extraction failed:', error);
    throw new Error('Failed to extract text from image using OCR');
  }
}
