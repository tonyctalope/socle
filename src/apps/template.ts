// What a new app starts from: the smallest app that builds, so that its draft address works
// at once and whoever writes the app sees the expected shape.

export function starterFiles(card: { name: string; description: string }): Record<string, string> {
  return {
    'app.json': `${JSON.stringify({ name: card.name, description: card.description }, null, 2)}\n`,
    'web/main.tsx': `import { Empty, Page } from '@socle/ui';

export default function App() {
  return (
    <Page title={${JSON.stringify(card.name)}}>
      <Empty title={${JSON.stringify(card.name)}} />
    </Page>
  );
}
`,
  };
}
