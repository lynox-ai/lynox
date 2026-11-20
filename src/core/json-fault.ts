/**
 * The fault of a `JSON.parse`, without the text it read. V8's SyntaxError for an unexpected
 * token quotes up to ten characters around the fault, and the whole input when it is short
 * (`Unexpected token 's', ..."api_key": sk-ant-abc"... is not valid JSON`). For a file that holds
 * a key or a token that quote is a piece of the secret, so a log line names the position only.
 */
export function jsonFault(err: SyntaxError): string {
  const at = /at position \d+(?: \(line \d+ column \d+\))?/.exec(err.message);
  return at ? `not valid JSON ${at[0]}` : 'not valid JSON';
}
