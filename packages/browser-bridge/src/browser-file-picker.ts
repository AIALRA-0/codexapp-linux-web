export interface BrowserPickFilesRequest {
  imagesOnly: boolean;
  requestId: string;
}

export interface BrowserPickedFile {
  fsPath: string;
  label: string;
  path: string;
}

export function parseBrowserPickFilesRequest(value: unknown): BrowserPickFilesRequest | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (
    message.type !== 'fetch' ||
    message.url !== 'vscode://codex/pick-files' ||
    typeof message.requestId !== 'string' ||
    message.requestId.length === 0
  ) {
    return null;
  }

  let imagesOnly = false;
  if (typeof message.body === 'string' && message.body.length > 0) {
    const parsed = JSON.parse(message.body) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      imagesOnly = (parsed as Record<string, unknown>).imagesOnly === true;
    }
  }
  return { imagesOnly, requestId: message.requestId };
}

export function browserPickedFiles(
  files: Iterable<File>,
  stageUpload: (file: File) => string | null,
): BrowserPickedFile[] {
  const result: BrowserPickedFile[] = [];
  for (const file of files) {
    const path = stageUpload(file);
    if (path === null) continue;
    result.push({ fsPath: path, label: file.name, path });
  }
  return result;
}

export function pickBrowserFiles(imagesOnly: boolean): Promise<File[]> {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    if (imagesOnly) input.accept = 'image/*';
    document.body.append(input);

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      const files = Array.from(input.files ?? []);
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', finish, { once: true });
    input.addEventListener('cancel', finish, { once: true });
    input.click();
  });
}

export function browserPickFilesSuccessMessage(
  requestId: string,
  files: BrowserPickedFile[],
): Record<string, unknown> {
  return {
    type: 'fetch-response',
    responseType: 'success',
    requestId,
    status: 200,
    headers: { 'content-type': 'application/json' },
    bodyJsonString: JSON.stringify({ files }),
  };
}
