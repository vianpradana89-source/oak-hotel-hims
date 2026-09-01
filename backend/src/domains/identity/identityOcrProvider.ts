import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { IdentityOcrProviderType } from './identityTypes';

export interface OcrExtractionOutput {
  raw_lines: string[];
  confidence: number;
  provider: string;
  error?: string | null;
}

export interface IdentityOcrProvider {
  readonly providerName: IdentityOcrProviderType;
  isAvailable(): Promise<boolean>;
  extractRawLines(imagePath: string, options?: { timeoutMs?: number }): Promise<OcrExtractionOutput>;
}

/**
 * Local PaddleOCR Provider Adapter
 * Executes the project-local Python PaddleOCR worker via child process IPC.
 */
export class LocalPaddleOcrProvider implements IdentityOcrProvider {
  readonly providerName: IdentityOcrProviderType = 'LOCAL_PADDLE_OCR';

  private resolvePythonPath(): string {
    if (process.env.PADDLE_OCR_PYTHON_PATH && fs.existsSync(process.env.PADDLE_OCR_PYTHON_PATH)) {
      return process.env.PADDLE_OCR_PYTHON_PATH;
    }

    // Check project-local virtual environment in backend/ocr/.venv
    const winVenv = path.resolve(__dirname, '../../../../backend/ocr/.venv/Scripts/python.exe');
    if (fs.existsSync(winVenv)) {
      return winVenv;
    }

    const unixVenv = path.resolve(__dirname, '../../../../backend/ocr/.venv/bin/python');
    if (fs.existsSync(unixVenv)) {
      return unixVenv;
    }

    // Relative to backend root
    const rootWinVenv = path.resolve(process.cwd(), 'ocr/.venv/Scripts/python.exe');
    if (fs.existsSync(rootWinVenv)) {
      return rootWinVenv;
    }

    return 'python';
  }

  private resolveWorkerScriptPath(): string {
    if (process.env.PADDLE_OCR_SCRIPT_PATH && fs.existsSync(process.env.PADDLE_OCR_SCRIPT_PATH)) {
      return process.env.PADDLE_OCR_SCRIPT_PATH;
    }

    const scriptPath = path.resolve(__dirname, '../../../../backend/ocr/ktp_ocr_worker.py');
    if (fs.existsSync(scriptPath)) {
      return scriptPath;
    }

    const rootScriptPath = path.resolve(process.cwd(), 'ocr/ktp_ocr_worker.py');
    if (fs.existsSync(rootScriptPath)) {
      return rootScriptPath;
    }

    return path.resolve(__dirname, '../../ocr/ktp_ocr_worker.py');
  }

  async isAvailable(): Promise<boolean> {
    const pythonPath = this.resolvePythonPath();
    const scriptPath = this.resolveWorkerScriptPath();
    return fs.existsSync(scriptPath) && (pythonPath === 'python' || fs.existsSync(pythonPath));
  }

  async extractRawLines(imagePath: string, options?: { timeoutMs?: number }): Promise<OcrExtractionOutput> {
    const pythonPath = this.resolvePythonPath();
    const scriptPath = this.resolveWorkerScriptPath();
    const timeout = options?.timeoutMs || Number(process.env.IDENTITY_OCR_TIMEOUT_MS) || 30000;

    if (!fs.existsSync(imagePath)) {
      return {
        raw_lines: [],
        confidence: 0.0,
        provider: this.providerName,
        error: `File tidak ditemukan: ${imagePath}`
      };
    }

    return new Promise((resolve) => {
      execFile(
        pythonPath,
        [scriptPath, imagePath],
        {
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            FLAGS_use_onednn: '0',
            GLOG_minloglevel: '3',
            PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True'
          }
        },
        (error, stdout, stderr) => {
          if (error) {
            console.warn('[LocalPaddleOcrProvider] Worker execution error:', error.message);
            return resolve({
              raw_lines: [],
              confidence: 0.0,
              provider: this.providerName,
              error: `OCR execution error: ${error.message}`
            });
          }

          try {
            const trimmed = (stdout || '').trim();
            // Extract JSON from stdout if any extraneous text preceded it
            const jsonStart = trimmed.indexOf('{');
            const jsonEnd = trimmed.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
              const jsonStr = trimmed.substring(jsonStart, jsonEnd + 1);
              const parsed = JSON.parse(jsonStr);
              return resolve({
                raw_lines: Array.isArray(parsed.raw_lines) ? parsed.raw_lines : [],
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.85,
                provider: this.providerName,
                error: parsed.error || null
              });
            } else {
              return resolve({
                raw_lines: [],
                confidence: 0.0,
                provider: this.providerName,
                error: `Respon OCR tidak dalam format JSON yang valid`
              });
            }
          } catch (parseErr: any) {
            return resolve({
              raw_lines: [],
              confidence: 0.0,
              provider: this.providerName,
              error: `Gagal mem-parsing output OCR: ${parseErr.message}`
            });
          }
        }
      );
    });
  }
}

/**
 * Gemini Multimodal Vision AI Provider
 * Uses Google Gemini 2.0/2.5 Flash via standard REST API for cloud AI extraction.
 */
export class GeminiOcrProvider implements IdentityOcrProvider {
  readonly providerName: IdentityOcrProviderType = 'GEMINI';

  private getApiKey(): string | null {
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.getApiKey());
  }

  async extractRawLines(imagePath: string, options?: { timeoutMs?: number }): Promise<OcrExtractionOutput> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return {
        raw_lines: [],
        confidence: 0.0,
        provider: this.providerName,
        error: 'GEMINI_API_KEY tidak dikonfigurasi di backend/.env'
      };
    }

    if (!fs.existsSync(imagePath)) {
      return {
        raw_lines: [],
        confidence: 0.0,
        provider: this.providerName,
        error: `File tidak ditemukan: ${imagePath}`
      };
    }

    try {
      const fileBuffer = fs.readFileSync(imagePath);
      const base64Data = fileBuffer.toString('base64');
      const ext = path.extname(imagePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.pdf' ? 'application/pdf' : 'image/jpeg';

      const prompt = `You are an expert OCR system specialized in Indonesian KTP (Kartu Tanda Penduduk).
Read this KTP image and output each text line verbatim from top to bottom, one line per line.
Include Province, Regency/City, NIK, Nama, Tempat/Tgl Lahir, Jenis Kelamin, Alamat, RT/RW, Kel/Desa, Kecamatan, Agama, Status Perkawinan, Pekerjaan, Kewarganegaraan, and Berlaku Hingga.
Output only the raw text lines, without any commentary, markdown asterisks or code fences.`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options?.timeoutMs || 25000);

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
      const payload = {
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1
        }
      };

      const res = await (globalThis as any).fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errorText = await res.text();
        return {
          raw_lines: [],
          confidence: 0.0,
          provider: this.providerName,
          error: `Gemini API error (${res.status}): ${errorText}`
        };
      }

      const data: any = await res.json();
      const textOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const lines = textOutput
        .split('\n')
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0);

      return {
        raw_lines: lines,
        confidence: 0.99,
        provider: this.providerName,
        error: null
      };
    } catch (err: any) {
      return {
        raw_lines: [],
        confidence: 0.0,
        provider: this.providerName,
        error: `Gemini OCR error: ${err.message}`
      };
    }
  }
}

/**
 * Google Cloud Vision API Provider
 * Uses @google-cloud/vision for enterprise DOCUMENT_TEXT_DETECTION and TEXT_DETECTION.
 */
export class GoogleVisionOcrProvider implements IdentityOcrProvider {
  readonly providerName: IdentityOcrProviderType = 'GOOGLE_VISION';
  private visionClient: any = null;

  private getVisionClient(): any {
    if (!this.visionClient) {
      try {
        const vision = require('@google-cloud/vision');
        const options: any = {};

        // 1. Check explicit Google Service Account key file path
        if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
          options.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        } else if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
          // 2. Check inline JSON or file path
          try {
            options.credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
          } catch {
            if (fs.existsSync(process.env.GCP_SERVICE_ACCOUNT_KEY)) {
              options.keyFilename = process.env.GCP_SERVICE_ACCOUNT_KEY;
            }
          }
        } else if (process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_API_KEY) {
          // 3. API Key support
          options.apiKey = process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_API_KEY;
        }

        this.visionClient = new vision.ImageAnnotatorClient(options);
      } catch (err: any) {
        console.warn('[GoogleVisionOcrProvider] Failed to initialize ImageAnnotatorClient:', err.message);
      }
    }
    return this.visionClient;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.GCP_SERVICE_ACCOUNT_KEY ||
      process.env.GOOGLE_VISION_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.NODE_ENV === 'production'
    );
  }

  async extractRawLines(imagePath: string, options?: { timeoutMs?: number }): Promise<OcrExtractionOutput> {
    if (!fs.existsSync(imagePath)) {
      return {
        raw_lines: [],
        confidence: 0.0,
        provider: this.providerName,
        error: `File tidak ditemukan: ${imagePath}`
      };
    }

    try {
      const client = this.getVisionClient();
      if (!client) {
        throw new Error('Google Cloud Vision client tidak dapat diinisialisasi');
      }

      // Execute documentTextDetection (preferred for dense ID cards like KTP)
      let fullText = '';
      try {
        const [result] = await client.documentTextDetection(imagePath);
        if (result?.fullTextAnnotation?.text) {
          fullText = result.fullTextAnnotation.text;
        } else if (result?.textAnnotations && result.textAnnotations.length > 0) {
          fullText = result.textAnnotations[0].description || '';
        }
      } catch (docErr: any) {
        // Fallback to textDetection
        console.warn('[GoogleVisionOcrProvider] documentTextDetection fallback to textDetection:', docErr.message);
        try {
          const [simpleResult] = await client.textDetection(imagePath);
          if (simpleResult?.textAnnotations && simpleResult.textAnnotations.length > 0) {
            fullText = simpleResult.textAnnotations[0].description || '';
          }
        } catch (simpleErr: any) {
          console.warn('[GoogleVisionOcrProvider] textDetection fallback also failed:', simpleErr.message);
        }
      }

      const lines = fullText
        .split(/\r?\n/)
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0);

      if (lines.length > 0) {
        return {
          raw_lines: lines,
          confidence: 0.99,
          provider: this.providerName,
          error: null
        };
      }

      // If Vision returned empty, try fallback to Gemini, Tesseract, or Local PaddleOCR
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
        try {
          const geminiProvider = new GeminiOcrProvider();
          const geminiResult = await geminiProvider.extractRawLines(imagePath, options);
          if (geminiResult.raw_lines.length > 0) {
            return geminiResult;
          }
        } catch {}
      }

      // Built-in Tesseract fallback
      try {
        const tesseractProvider = new TesseractJsOcrProvider();
        if (await tesseractProvider.isAvailable()) {
          const tesseractRes = await tesseractProvider.extractRawLines(imagePath, options);
          if (tesseractRes.raw_lines.length > 0) {
            return tesseractRes;
          }
        }
      } catch {}

      try {
        const paddleProvider = new LocalPaddleOcrProvider();
        if (await paddleProvider.isAvailable()) {
          const paddleRes = await paddleProvider.extractRawLines(imagePath, options);
          if (paddleRes.raw_lines.length > 0) {
            return paddleRes;
          }
        }
      } catch {}

      return {
        raw_lines: [],
        confidence: 0.0,
        provider: this.providerName,
        error: 'Google Cloud Vision tidak mendeteksi teks dalam gambar'
      };
    } catch (err: any) {
      console.warn('[GoogleVisionOcrProvider] Extraction error:', err.message);

      // Attempt fallback to Gemini, Tesseract, or local provider
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
        try {
          const geminiProvider = new GeminiOcrProvider();
          const fallbackRes = await geminiProvider.extractRawLines(imagePath, options);
          if (fallbackRes.raw_lines.length > 0) {
            return fallbackRes;
          }
        } catch {}
      }

      try {
        const tesseractProvider = new TesseractJsOcrProvider();
        if (await tesseractProvider.isAvailable()) {
          const fallbackRes = await tesseractProvider.extractRawLines(imagePath, options);
          if (fallbackRes.raw_lines.length > 0) {
            return fallbackRes;
          }
        }
      } catch {}

      try {
        const paddleProvider = new LocalPaddleOcrProvider();
        if (await paddleProvider.isAvailable()) {
          const fallbackRes = await paddleProvider.extractRawLines(imagePath, options);
          if (fallbackRes.raw_lines.length > 0) {
            return fallbackRes;
          }
        }
      } catch {}

      return {
        raw_lines: [],
        confidence: 0.0,
        provider: this.providerName,
        error: `Google Vision API error: ${err.message}`
      };
    }
  }
}

/**
 * Built-in Node.js Tesseract OCR Provider
 * Operates offline without external Python runtime or cloud API keys.
 */
export class TesseractJsOcrProvider implements IdentityOcrProvider {
  readonly providerName: IdentityOcrProviderType = 'TESSERACT';

  async isAvailable(): Promise<boolean> {
    try {
      require('tesseract.js');
      return true;
    } catch {
      return false;
    }
  }

  async extractRawLines(imagePath: string, _options?: { timeoutMs?: number }): Promise<OcrExtractionOutput> {
    if (!fs.existsSync(imagePath)) {
      return {
        raw_lines: [],
        confidence: 0.0,
        provider: this.providerName,
        error: `File tidak ditemukan: ${imagePath}`
      };
    }

    try {
      const Tesseract = require('tesseract.js');
      const { data: { text, confidence } } = await Tesseract.recognize(imagePath, 'eng', {
        logger: () => {}
      });

      const lines = (text || '')
        .split(/\r?\n/)
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0);

      return {
        raw_lines: lines,
        confidence: typeof confidence === 'number' && confidence > 0 ? confidence / 100 : 0.92,
        provider: this.providerName,
        error: null
      };
    } catch (err: any) {
      console.warn('[TesseractJsOcrProvider] Error:', err.message);
      return {
        raw_lines: [],
        confidence: 0.0,
        provider: this.providerName,
        error: `Tesseract OCR error: ${err.message}`
      };
    }
  }
}

/**
 * Manual Fallback Provider
 */
export class ManualOcrProvider implements IdentityOcrProvider {
  readonly providerName: IdentityOcrProviderType = 'MANUAL';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async extractRawLines(_imagePath: string): Promise<OcrExtractionOutput> {
    return {
      raw_lines: [],
      confidence: 0.0,
      provider: this.providerName,
      error: null
    };
  }
}

/**
 * Factory for resolving active OCR provider
 */
export function getOcrProvider(): IdentityOcrProvider {
  const isEnabled = process.env.IDENTITY_OCR_ENABLED !== 'false';
  const providerType = (process.env.IDENTITY_OCR_PROVIDER || 'GOOGLE_VISION').toUpperCase();

  if (!isEnabled) {
    return new ManualOcrProvider();
  }

  switch (providerType) {
    case 'GOOGLE_VISION':
    case 'VISION':
    case 'GCP_VISION':
      return new GoogleVisionOcrProvider();
    case 'GEMINI':
      return new GeminiOcrProvider();
    case 'TESSERACT':
    case 'TESSERACT_JS':
      return new TesseractJsOcrProvider();
    case 'LOCAL_PADDLE_OCR':
      return new LocalPaddleOcrProvider();
    case 'MANUAL':
      return new ManualOcrProvider();
    default:
      // Default to Google Cloud Vision Provider with automatic fallback
      return new GoogleVisionOcrProvider();
  }
}
