import re

with open('../frontend/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix backticks escaped as \` -> `
content = content.replace('\\`', '`')
# Fix dollar signs escaped as \$ -> $
content = content.replace('\\$', '$')
# Fix escaped slashes \\/ -> \/
content = content.replace('\\\\/', '\\/')

with open('../frontend/index.html', 'w', encoding='utf-8') as f:
    f.write(content)
