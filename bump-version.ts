import { readFileSync, writeFileSync } from 'fs';

// Read the package.json file
const packageJson = JSON.parse(readFileSync('package.json', 'utf-8'));

// Split the version into major, minor, and patch
const [major, minor, patch] = packageJson.version.split('.').map(Number);

// Increment the patch version
const newVersion = `${major}.${minor}.${patch + 1}`;

// Update the version in the package.json object
packageJson.version = newVersion;

// Write the updated package.json back to the file
writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');

console.log(`Version bumped to ${newVersion}`);

