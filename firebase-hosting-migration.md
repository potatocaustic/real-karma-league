# Firebase Hosting Migration Roadmap

This roadmap walks through moving the existing static site from Vercel to Firebase Hosting while keeping Firebase Authentication, Firestore, and Cloud Functions unchanged. It is written to be exhaustive so you can follow it step-by-step.

## 1) Prerequisites and verification
- **Access**: Confirm you have Owner/Editor rights to the Firebase project and DNS for your custom domain (if used in Vercel).
- **CLI setup**: Install/update the Firebase CLI (`npm install -g firebase-tools`) and log in (`firebase login`).
- **Project selection**: From the repo root, run `firebase use <projectId>` to ensure deployments target the correct Firebase project.
- **Existing config check**: Verify that `firebase.json` already maps Hosting to the repo root and ignores Functions and dependencies; this project is already configured for static hosting from `.` with appropriate ignore rules.【F:firebase.json†L1-L17】

## 2) Inventory current hosting behavior
- **Static assets**: Note that the site is purely static (HTML/CSS/JS) and depends on Firebase SDK calls; there are no Vercel serverless routes to migrate.
- **Headers**: The only Vercel-specific behavior is an immutable cache rule for `/icons/*` declared in `vercel.json`. Plan to carry this over to Firebase Hosting headers/caching settings or CDN policies.【F:vercel.json†L1-L13】
- **Analytics/insights**: If you use Vercel Analytics/Speeds Insights snippets in HTML, note their removal if desired.

## 3) Prepare Firebase Hosting config
- **Add headers (optional but recommended)**: In `firebase.json`, under `hosting`, add a `headers` block mirroring the `/icons/*` cache policy from Vercel. Example:
  ```json
  "headers": [
    {
      "source": "/icons/**",
      "headers": [{"key": "Cache-Control", "value": "public, max-age=86400, immutable"}]
    }
  ]
  ```
- **Set clean URLs / rewrites**: If you need SPA-style routing or deep-link support, add `rewrites` and `cleanUrls` as appropriate. For the current multi-page static site, no rewrites are required.
- **.firebase directory**: Ensure `.firebase/` is gitignored (Firebase CLI manages it automatically).

## 4) Dry run and validation
- **Local preview**: Run `firebase hosting:preview` or `firebase emulators:start --only hosting` and open the provided localhost URL. Validate page rendering, Firebase Auth flows, Firestore reads/writes, and Callable Functions invocations.
- **Asset checks**: Confirm that icons and other static assets resolve correctly and that caching headers behave as expected using browser dev tools.
- **404s**: Use the browser console and network panel to confirm no missing files or misrouted requests.

## 5) Deployment to Firebase Hosting
- **Initial deploy**: From the repo root, run `firebase deploy --only hosting`. This uploads the static site as configured in `firebase.json` and serves it on your default Firebase subdomain (e.g., `https://<projectId>.web.app`).
- **Smoke test**: Visit the Firebase subdomain and repeat the validation from Step 4 to confirm production behavior matches Vercel.

## 6) Custom domain cutover
- **Add domain**: In the Firebase console (Hosting > Add custom domain), enter your existing Vercel custom domain.
- **DNS changes**: Update DNS records per Firebase prompts (typically two `A` records to `199.36.158.100/101` plus optional `AAAA` for IPv6). If Vercel manages DNS, move the domain to your registrar or another DNS host, then create the Firebase records.
- **Propagation monitoring**: Use `dig`/`nslookup` or Firebase Hosting console status to watch DNS propagation. Keep Vercel running until Firebase shows the domain as “Connected” and the site serves correctly.
- **TLS**: Firebase will provision SSL certificates automatically once DNS is verified.

## 7) Post-cutover cleanup
- **Remove Vercel deployment hooks**: Disable Vercel automatic deployments and remove any Vercel webhooks from your repo settings/CI.
- **Delete Vercel project (optional)**: After confirming traffic is fully on Firebase, delete or downgrade the Vercel project to end billing for the paid plan.
- **Remove Vercel-specific files (optional)**: If you no longer need them, delete `vercel.json` and any Vercel analytics snippets from HTML. Keep them only if you want an easy rollback path.

## 8) Rollback / fallback strategy
- **Dual hosting during transition**: Keep Vercel deployments intact until DNS is fully propagated and Firebase Hosting is validated.
- **Emergency rollback**: If issues occur post-cutover, point DNS back to Vercel’s records and redeploy there using existing settings. Because the site is static, rollback is DNS-only and fast.

## 9) Cost and monitoring
- **Cost savings**: Once Vercel is removed/downgraded, static hosting costs shift entirely to Firebase. Firebase Hosting includes generous free quotas; ongoing costs will primarily be Firestore/Functions usage, which remain unchanged.
- **Monitoring**: Use Firebase Hosting logs and the Firebase console to monitor traffic. If desired, integrate Google Analytics or Cloud Logging for more detailed observability.

## 10) Documentation and team readiness
- **README update**: Document the new deploy command (`firebase deploy --only hosting`) and any added headers/rewrites so contributors can reproduce deployments.
- **Access sharing**: Ensure teammates have Firebase project access and CLI authentication instructions.
- **Checklist before sunsetting Vercel**:
  - Firebase Hosting deploy tested and live on Firebase subdomain.
  - Custom domain points to Firebase and serves correct content over HTTPS.
  - No missing assets or header regressions (especially `/icons/**`).
  - Vercel billing cancelled/downgraded after verification.
