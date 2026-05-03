const fs = require('fs');
const code = fs.readFileSync('.gemini/scratch/3.10.12-min.js', 'utf8');

// Extract config
const configMatch = code.match(/const e=(\{version:"3\.10\.12".*?\});function t\(e\)/);
if (configMatch) {
  fs.writeFileSync('.gemini/scratch/config.json', configMatch[1].replace(/!0/g, 'true').replace(/!1/g, 'false').replace(/([a-zA-Z0-9_]+):/g, '"$1":'));
  console.log("Config extracted.");
}

// Extract styles
const styleMatch = code.match(/return`([^`]*)`/);
if (styleMatch) {
  fs.writeFileSync('.gemini/scratch/styles.css', styleMatch[1]);
  console.log("Styles extracted.");
}
