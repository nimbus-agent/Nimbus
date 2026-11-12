/** One Slack Web API reply: `ok` only when Slack said so AND the HTTP status was 2xx. */
export type SlackApiReply = { ok: boolean; json: Record<string, unknown>; text: string };

/**
 * POSTs one Slack Web API method with a bearer token. `signal` (optional) aborts the request and its
 * body read. A reply that is not a JSON object comes back as `{ ok: false, json: {}, text }`.
 */
export async function slackWebApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SlackApiReply> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, json: {}, text };
  }
  const json =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const okField = json["ok"];
  return { ok: okField === true && res.ok, json, text };
}
