import re
import json

with open('.gemini/scratch/3.10.12-min.js', 'r') as f:
    code = f.read()

# Extract Config
config_match = re.search(r'const e=(\{version:"3\.10\.12".*?\});function t\(e\)', code)
if config_match:
    config_str = config_match.group(1)
    # Basic replacements to make it JSON-like
    config_str = config_str.replace('!0', 'true').replace('!1', 'false')
    # Use a regex to quote unquoted keys
    config_str = re.sub(r'([a-zA-Z0-9_]+):', r'"\1":', config_str)
    try:
        with open('.gemini/scratch/config.json', 'w') as f:
            f.write(json.dumps(json.loads(config_str), indent=2))
        print("Config extracted.")
    except Exception as e:
        with open('.gemini/scratch/config.json', 'w') as f:
            f.write(config_str) # write raw if JSON parse fails
        print(f"Config extracted (raw): {e}")

# Extract styles
style_match = re.search(r'return`([^`]*)`', code)
if style_match:
    with open('.gemini/scratch/styles.css', 'w') as f:
        f.write(style_match.group(1))
    print("Styles extracted.")
