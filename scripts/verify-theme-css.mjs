import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const assetsDirectory = join(process.cwd(), 'dist', 'assets');
const cssFiles = (await readdir(assetsDirectory))
  .filter(file => file.endsWith('.css'))
  .sort();

if (cssFiles.length === 0) {
  throw new Error('[theme-css] production build emitted no CSS assets');
}

const css = (await Promise.all(
  cssFiles.map(file => readFile(join(assetsDirectory, file), 'utf8')),
)).join('\n');

const requiredFragments = [
  '.font-sans{font-family:var(--font-body)}',
  '.font-mono{font-family:var(--font-code)}',
  '.rounded{border-radius:var(--theme-radius-base)}',
  '--radius-sm:var(--theme-radius-sm)',
  '--radius-md:var(--theme-radius-md)',
  '--radius-lg:var(--theme-radius-lg)',
  '--radius-xl:var(--theme-radius-xl)',
  '--radius-2xl:var(--theme-radius-2xl)',
  '.rounded-sm{border-radius:var(--theme-radius-sm)}',
  '.rounded-md{border-radius:var(--theme-radius-md)}',
  '.rounded-lg{border-radius:var(--theme-radius-lg)}',
  '.rounded-xl{border-radius:var(--theme-radius-xl)}',
  '.rounded-2xl{border-radius:var(--theme-radius-2xl)}',
  '.rounded-full{border-radius:var(--theme-radius-full)}',
  '.shadow{--tw-shadow:var(--theme-shadow-base);',
  '--shadow-xs:var(--theme-shadow-xs)',
  '--shadow-sm:var(--theme-shadow-sm)',
  '--shadow-md:var(--theme-shadow-md)',
  '--shadow-lg:var(--theme-shadow-lg)',
  '--shadow-xl:var(--theme-shadow-xl)',
  '.shadow-xs{--tw-shadow:var(--theme-shadow-xs);',
  '.shadow-sm{--tw-shadow:var(--theme-shadow-sm);',
  '.shadow-md{--tw-shadow:var(--theme-shadow-md);',
  '.shadow-lg{--tw-shadow:var(--theme-shadow-lg);',
  '.shadow-xl{--tw-shadow:var(--theme-shadow-xl);',
  '.shadow-2xl{--tw-shadow:var(--theme-shadow-2xl);',
  '.hover\\:shadow-sm:hover{--tw-shadow:var(--theme-shadow-sm);',
  '.transition-shadow{transition-property:box-shadow;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function));transition-duration:var(--tw-duration,var(--duration-fast))}',
  '.duration-150{--tw-duration:var(--duration-fast);transition-duration:var(--duration-fast)}',
  '.duration-200{--tw-duration:var(--duration-normal);transition-duration:var(--duration-normal)}',
  '.duration-300{--tw-duration:var(--duration-slow);transition-duration:var(--duration-slow)}',
];

const missing = requiredFragments.filter(fragment => !css.includes(fragment));
if (missing.length > 0) {
  throw new Error(
    `[theme-css] Tailwind utilities bypass the runtime Theme bridge:\n${missing.join('\n')}`,
  );
}

if (css.includes('@theme')) {
  throw new Error('[theme-css] raw @theme directive leaked into the browser bundle');
}

console.log(`[theme-css] verified ${requiredFragments.length} runtime Theme utility mappings`);
