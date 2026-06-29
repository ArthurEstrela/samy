/// <reference types="vite/client" />

declare module '@fontsource-variable/fraunces';
declare module '@fontsource-variable/hanken-grotesk';
declare module '@fontsource/space-mono';

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }

interface Window {
  google?: {
    accounts: {
      id: {
        initialize: (config: { client_id: string; callback: (resp: { credential: string }) => void }) => void;
        renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
      };
    };
  };
}
