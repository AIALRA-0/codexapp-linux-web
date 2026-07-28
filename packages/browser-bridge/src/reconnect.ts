export function isTerminalBridgeCloseCode(code: number): boolean {
  return code === 4400 || code === 4401 || code === 4403 || code === 4408 || code === 4409;
}
