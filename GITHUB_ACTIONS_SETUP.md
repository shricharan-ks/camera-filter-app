# GitHub Actions Setup Guide

This guide will help you configure automated Firebase Hosting deployments using GitHub Actions.

## Prerequisites

- Firebase CLI installed (`npm install -g firebase-tools`)
- Access to your GitHub repository settings
- Firebase project with Hosting enabled

## Step 1: Generate Firebase CI Token

Run this command in your terminal:

```bash
firebase login:ci
```

This will:
1. Open a browser window for authentication
2. Ask you to authorize Firebase CLI
3. Generate a CI token and display it in the terminal

**Copy the token** - you'll need it in the next step.

Example output:
```
✔  Success! Use this token to login on a CI server:

1//0gABCDEF1234567890...

Example: firebase deploy --token "$FIREBASE_TOKEN"
```

## Step 2: Add Token to GitHub Secrets

1. Go to your GitHub repository: https://github.com/shricharan-ks/camera-filter-app

2. Click on **Settings** (in the repository menu)

3. In the left sidebar, click **Secrets and variables** → **Actions**

4. Click the **New repository secret** button

5. Fill in the details:
   - **Name:** `FIREBASE_TOKEN`
   - **Secret:** Paste the token from Step 1

6. Click **Add secret**

## Step 3: Test the Workflow

The workflow is already configured and will run automatically on every push to the `main` branch.

To test it manually:

1. Go to the **Actions** tab in your repository
2. Click on "Deploy to Firebase Hosting" workflow
3. Click **Run workflow** → **Run workflow**
4. Watch the deployment progress

## Workflow Details

The workflow (`.github/workflows/firebase-deploy.yml`) will:

✅ Trigger on every push to `main` branch
✅ Checkout the code
✅ Setup Node.js 18
✅ Install dependencies (`npm ci`)
✅ Deploy to Firebase Hosting using the token

## Verify Deployment

After a successful workflow run:

1. Check the Actions tab for a green checkmark ✅
2. Visit your live site: https://dmk-kumarapalayam.web.app
3. Verify the changes are live

## Troubleshooting

### "FIREBASE_TOKEN secret not found"

**Solution:** Make sure you added the secret with the exact name `FIREBASE_TOKEN` (all caps).

### "Permission denied" or "Authentication error"

**Solution:**
- Generate a new token with `firebase login:ci`
- Update the GitHub secret with the new token
- Make sure you're logged into the correct Firebase account

### Workflow fails with "npm ci" error

**Solution:**
- Check that `package-lock.json` is committed to the repository
- Try deleting and regenerating `package-lock.json` locally
- Commit and push the updated file

### Deployment succeeds but changes not visible

**Solution:**
- Clear browser cache (Ctrl+Shift+R or Cmd+Shift+R)
- Check Firebase Hosting dashboard for recent deployments
- Wait 1-2 minutes for CDN propagation

## Manual Deployment (Backup)

If GitHub Actions is down, you can always deploy manually:

```bash
firebase deploy --only hosting
```

## Security Notes

- ✅ The Firebase token is stored as an encrypted secret
- ✅ The token is never exposed in logs
- ✅ The token only has deployment permissions (no admin access)
- ⚠️ Never commit the token directly to your code
- ⚠️ Rotate the token if you suspect it's been compromised

## Next Steps

Once configured, every commit to `main` will automatically deploy to Firebase Hosting. No manual deployment needed! 🚀

---

**Need Help?** Open an issue on GitHub or check the [Firebase Documentation](https://firebase.google.com/docs/hosting/github-integration).
