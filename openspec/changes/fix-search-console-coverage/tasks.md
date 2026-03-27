## 1. Sitemap Cleanup

- [x] 1.1 Remove `/subscribe` entry from `site/sitemap.xml`
- [x] 1.2 Add 7 humans subpages to `site/sitemap.xml`: `about.html`, `faq.html`, `privacy.html`, `terms.html`, `legal.html`, `vision.html`, `mpp.html`
- [x] 1.3 Add `/agencies` and `/freelance` to `site/sitemap.xml`
- [x] 1.4 Add `/use-cases` to `site/sitemap.xml`

## 2. Use-Cases Index Page

- [x] 2.1 Create `site/use-cases/index.html` with links to all 4 use-case pages, matching site styling
- [ ] 2.2 Verify `/use-cases` resolves to the new page locally (or via curl after deploy)

## 3. Custom 404 Error Page

- [x] 3.1 Create `site/404.html` with inline styles, branded design, and a link back to homepage
- [x] 3.2 Add CloudFront `errorResponses` to `infra/lib/site-stack.ts` mapping 403 → 404 with `/404.html`

## 4. Deploy & Verify

- [ ] 4.1 Push site changes to S3 (via git push to main, or manual `aws s3 sync`)
- [ ] 4.2 Deploy CDK Site stack for the CloudFront error response config
- [ ] 4.3 Verify `/use-cases` returns 200, `/nonexistent` returns 404 with branded page, and sitemap is correct
