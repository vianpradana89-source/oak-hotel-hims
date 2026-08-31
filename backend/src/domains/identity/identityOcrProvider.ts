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
  const providerType = (process.env.IDENTITY_OCR_PROVIDER || 'LOCAL_PADDLE_OCR').toUpperCase();

  if (!isEnabled) {
    return new ManualOcrProvider();
  }

  switch (providerType) {
    case 'GEMINI':
      return new GeminiOcrProvider();
    case 'LOCAL_PADDLE_OCR':
      return new LocalPaddleOcrProvider();
    case 'MANUAL':
      return new ManualOcrProvider();
    default:
      console.warn(`[IdentityOCR] Unknown provider "${providerType}", falling back to LOCAL_PADDLE_OCR`);
      return new LocalPaddleOcrProvider();
  }
}
