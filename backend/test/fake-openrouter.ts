/**
 * A fetch that answers OpenRouter's two ZDR lookups (QOR-4769): each model's endpoints
 * from `served`, the ZDR list from `listed`. Any other URL is a 404. Every URL is recorded.
 */
export function fakeOpenRouter(served: Record<string, string[]>, listed: string[]) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://openrouter.ai/api/v1/endpoints/zdr') return Response.json({ data: listed.map((name) => ({ name })) });
    const model = Object.keys(served).find((m) => url === `https://openrouter.ai/api/v1/models/${m}/endpoints`);
    if (!model) return new Response('not found', { status: 404 });
    return Response.json({ data: { endpoints: served[model]!.map((name) => ({ name })) } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
