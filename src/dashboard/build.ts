const result = await Bun.build({
  entrypoints: ['./src/dashboard/client/index.tsx'],
  outdir: './src/dashboard/dist',
  minify: process.env.NODE_ENV === 'production',
  target: 'browser',
  naming: '[name].[ext]',
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`Built ${result.outputs.length} files to src/dashboard/dist/`);
