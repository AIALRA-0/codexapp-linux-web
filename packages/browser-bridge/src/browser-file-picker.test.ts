import { describe, expect, it } from 'vitest';

import {
  browserPickFilesSuccessMessage,
  browserPickedFiles,
  parseBrowserPickFilesRequest,
} from './browser-file-picker.js';

describe('browser file picker adapter', () => {
  it('recognizes the exact official desktop file picker request', () => {
    expect(
      parseBrowserPickFilesRequest({
        body: JSON.stringify({ imagesOnly: true, pickerTitle: 'Select photos' }),
        requestId: 'picker-1',
        type: 'fetch',
        url: 'vscode://codex/pick-files',
      }),
    ).toEqual({ imagesOnly: true, requestId: 'picker-1' });
    expect(
      parseBrowserPickFilesRequest({
        requestId: 'other',
        type: 'fetch',
        url: 'vscode://codex/read-file',
      }),
    ).toBeNull();
  });

  it('maps selected browser files to the unchanged official response shape', () => {
    const file = new File(['attachment'], 'evidence.txt', { type: 'text/plain' });
    const files = browserPickedFiles([file], () => '/uploads/picker/evidence.txt');
    expect(files).toEqual([
      {
        fsPath: '/uploads/picker/evidence.txt',
        label: 'evidence.txt',
        path: '/uploads/picker/evidence.txt',
      },
    ]);
    expect(browserPickFilesSuccessMessage('picker-1', files)).toMatchObject({
      bodyJsonString: JSON.stringify({ files }),
      requestId: 'picker-1',
      responseType: 'success',
      status: 200,
      type: 'fetch-response',
    });
  });
});
