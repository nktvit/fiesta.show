const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'environments');
const file = path.join(dir, 'environment.ts');

// Skip if file already exists (local dev)
if (fs.existsSync(file)) {
  console.log('Environment file already exists, skipping generation.');
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });

const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

const content = isProduction
  ? `export const environment = {
  production: true,
  deployEnv: '${process.env.VERCEL_ENV || 'production'}',
  OMDB_API_KEY: '',
};
`
  : `export const environment = {
  production: false,
  deployEnv: 'development',
  OMDB_API_KEY: '${process.env.OMDB_API_KEY || ''}',
};
`;

fs.writeFileSync(file, content);
console.log(`Generated ${file} (production: ${isProduction})`);
