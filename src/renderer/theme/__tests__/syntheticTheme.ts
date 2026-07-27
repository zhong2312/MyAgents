import stylesheetText from './synthetic-test-theme.css?inline';
import type { ThemeDefinition, ThemeSchemeDefinition, WidgetThemeAdapter } from '../types';

export const SYNTHETIC_THEME_ID = 'synthetic-test-theme';

function widget(dark: boolean): WidgetThemeAdapter {
  const text = dark ? '#ffe8ff' : '#21002f';
  const secondary = dark ? '#f2c8f4' : '#724b7c';
  const muted = dark ? '#c89dcc' : '#96759f';
  const background = dark ? '#120012' : '#fff0ff';
  const elevated = dark ? '#240024' : '#fff8ff';
  const inset = dark ? '#090009' : '#efd0f5';
  const accent = dark ? '#dd00dd' : '#aa00aa';
  return {
    variables: {
      '--widget-text': text,
      '--widget-text-secondary': secondary,
      '--widget-text-muted': muted,
      '--widget-bg': background,
      '--widget-bg-elevated': elevated,
      '--widget-bg-inset': inset,
      '--widget-border': dark ? 'rgb(255 232 255 / 0.18)' : 'rgb(33 0 47 / 0.18)',
      '--widget-border-strong': dark ? 'rgb(255 232 255 / 0.3)' : 'rgb(33 0 47 / 0.3)',
      '--widget-accent': accent,
      '--widget-accent-hover': dark ? '#ff33ff' : '#cc22cc',
      '--widget-accent-subtle': dark ? 'rgb(221 0 221 / 0.18)' : 'rgb(170 0 170 / 0.12)',
      '--widget-success': '#087f5b',
      '--widget-success-bg': dark ? '#073d31' : '#d8f3e8',
      '--widget-error': '#c92a2a',
      '--widget-error-bg': dark ? '#4b1515' : '#ffe3e3',
      '--widget-warning': '#b26a00',
      '--widget-warning-bg': dark ? '#493000' : '#fff0c2',
      '--widget-info': '#1864ab',
      '--widget-info-bg': dark ? '#102f4c' : '#dbeeff',
      '--widget-primary-text': '#ffffff',
      '--widget-font-body': "Georgia, 'Times New Roman', serif",
      '--widget-radius-track': '2px',
      '--widget-radius-control': '5px',
      '--widget-radius-card': '9px',
      '--widget-radius-full': '9999px',
      '--widget-control-shadow': `0 2px 7px ${dark ? 'rgb(0 0 0 / 0.5)' : 'rgb(33 0 47 / 0.22)'}`,
    },
  };
}

function scheme(marker: string, dark: boolean): ThemeSchemeDefinition {
  const palette = dark ? {
    background: '#120012', foreground: '#ffe8ff', cursor: '#dd00dd', cursorAccent: '#120012',
    selectionBackground: 'rgba(221, 0, 221, 0.3)', selectionInactiveBackground: 'rgba(221, 0, 221, 0.18)',
    black: '#090009', red: '#ff6b6b', green: '#63e6be', yellow: '#ffd43b', blue: '#74c0fc',
    magenta: '#e599f7', cyan: '#66d9e8', white: '#f8f0fc', brightBlack: '#916d96',
    brightRed: '#ffa8a8', brightGreen: '#96f2d7', brightYellow: '#ffe066', brightBlue: '#a5d8ff',
    brightMagenta: '#eebefa', brightCyan: '#99e9f2', brightWhite: '#ffffff',
  } : {
    background: '#fff0ff', foreground: '#21002f', cursor: '#aa00aa', cursorAccent: '#fff0ff',
    selectionBackground: 'rgba(170, 0, 170, 0.22)', selectionInactiveBackground: 'rgba(170, 0, 170, 0.12)',
    black: '#21002f', red: '#c92a2a', green: '#087f5b', yellow: '#b26a00', blue: '#1864ab',
    magenta: '#aa00aa', cyan: '#006f8f', white: '#f8ddff', brightBlack: '#724b7c',
    brightRed: '#e03131', brightGreen: '#099268', brightYellow: '#e67700', brightBlue: '#1971c2',
    brightMagenta: '#cc22cc', brightCyan: '#008fb5', brightWhite: '#ffffff',
  };
  return {
    xterm: {
      palette,
      fontFamily: `'${marker}-xterm-font', monospace`,
      fontSize: dark ? 19 : 17,
      lineHeight: dark ? 1.9 : 1.7,
    },
    monaco: {
      name: `${marker}-monaco`,
      fontFamily: `'${marker}-monaco-font', monospace`,
      fontSize: dark ? 21 : 18,
      lineHeight: dark ? 31 : 28,
      data: {
        base: dark ? 'vs-dark' : 'vs',
        inherit: false,
        rules: [{ token: 'keyword', foreground: dark ? 'DD00DD' : 'AA00AA' }],
        colors: {
          'editor.background': dark ? '#120012' : '#fff0ff',
          'editor.foreground': dark ? '#ffe8ff' : '#21002f',
        },
      },
    },
    mermaid: {
      theme: dark ? 'dark' : 'neutral',
      fontFamily: `'${marker}-mermaid-font', serif`,
      themeVariables: {
        primaryColor: dark ? '#240024' : '#efd0f5',
        primaryTextColor: dark ? '#ffe8ff' : '#21002f',
        primaryBorderColor: dark ? '#dd00dd' : '#aa00aa',
        lineColor: dark ? '#c89dcc' : '#724b7c',
        secondaryColor: dark ? '#102f4c' : '#dbeeff',
        tertiaryColor: dark ? '#073d31' : '#d8f3e8',
      },
    },
    prism: {
      'code[class*="language-"]': { color: dark ? '#ffe8ff' : '#21002f' },
    },
    widget: widget(dark),
  };
}

const noBackground = {
  assetUrl: null,
  position: 'center',
  size: 'cover',
  repeat: 'no-repeat',
  mask: null,
} as const;

export const syntheticTheme: ThemeDefinition = {
  id: SYNTHETIC_THEME_ID,
  displayName: 'Synthetic Theme',
  description: 'Test-only complete Theme with sentinel values',
  stylesheetText,
  hero: {
    productName: 'Synthetic Agents',
    slogans: {
      'zh-CN': '合成主题标记',
      'en-US': 'Synthetic theme sentinel',
    },
    backgrounds: {
      light: noBackground,
      dark: { ...noBackground, position: 'right top' },
    },
  },
  schemes: {
    light: scheme('synthetic-light', false),
    dark: scheme('synthetic-dark', true),
  },
};
