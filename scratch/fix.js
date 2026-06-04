const fs = require('fs');
let html = fs.readFileSync('../frontend/index.html', 'utf8');
html = html.replace(/\\\/g, '\'').replace(/\\\$/g, '$').replace(/\\\\\\\\/g, '\\\\');
fs.writeFileSync('../frontend/index.html', html);
