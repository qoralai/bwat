import { JSDOM } from 'jsdom';

/** What in a page would need 'unsafe-inline' to run: inline scripts, on*= handlers, javascript: links. */
export function inline(html: string): string[] {
  const { document } = new JSDOM(html).window;
  return [
    ...[...document.querySelectorAll('script:not([src])')].map((el) => `<script>${el.textContent!.slice(0, 40)}`),
    ...[...document.querySelectorAll('*')].flatMap((el) => el.getAttributeNames().filter((a) => a.startsWith('on')).map((a) => `${el.tagName} ${a}=`)),
    ...[...document.querySelectorAll('[href^="javascript:" i], [src^="javascript:" i]')].map((el) => `${el.tagName} javascript:`),
  ];
}

/**
 * Every page a test's server rendered that needs an inline script, outside Fastify's error
 * handling (a 500 a test ignores would hide it): test/html-checks.ts fails the test that left one.
 */
export const violations: string[] = [];
export function check(where: string, html: string): void {
  for (const found of inline(html)) violations.push(`${where}: ${found}`);
}
