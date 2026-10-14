{
  "name": "{{SLUG}}",
  "version": "1.0.0",
  "description": {{IDEA_JSON}},
  "type": "module",
  "main": "src/app.js",
  "scripts": {
    "start": "node src/app.js",
    "test": "node --test"
  },
  "dependencies": {{APPPORT_DEPENDENCIES}},
  "devDependencies": {{APPPORT_DEV_DEPENDENCIES}},
  "engines": {
    "node": ">=20"
  },
  "license": "MIT"
}
