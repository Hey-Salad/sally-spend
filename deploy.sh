#!/usr/bin/env bash
# Publish a read-only copy of the audit page (approval tokens stripped) to Cloudflare Pages.
set -e; rm -rf dist; cp -r public dist
node -e "const f='dist/decisions.json',L=require('./'+f);L.decisions.forEach(d=>delete d.approvalToken);require('fs').writeFileSync(f,JSON.stringify(L,null,1))"
mkdir -p node_modules && npx -y wrangler deploy
