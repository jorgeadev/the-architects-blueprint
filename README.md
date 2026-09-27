<div align="center">

# 📚 The Architect's Blueprint Pipeline

**An Uncompromising, Zero-Cost Automated Digest of Advanced Computing Paradigms.**

<br />

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-24-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Google_Gemini-2.5_Flash-4285F4?style=for-the-badge&logo=google&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=github-actions&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)
![License: CC BY 4.0](https://img.shields.io/badge/License-CC_BY_4.0-lightgrey.svg?style=for-the-badge)

<p align="center">
  <em>A serverless, precision-engineered learning conduit delivering rigorous, thesis-level insights into backend architectures, distributed systems, and infrastructure natively into your repository.</em>
</p>

</div>

---

## 📑 Table of Contents

- [✨ Core Features](#-core-features)
- [⚙️ Architecture & Workflow](#️-architecture--workflow)
- [🚀 Quick Start Guide](#-quick-start-guide)
    - [Environment Setup](#environment-setup)
    - [Observability](#observability)
- [🤖 Production Deployment](#-production-deployment)
- [📜 License](#-license)

---

## ✨ Core Features

- **🧠 Deep-Dive Epistemology:** Leverages **Google Gemini (2.5 Flash)** to generate highly structured, 20-35 minute long thesis-quality reading sessions every day mapping complex technological landscapes.
- **☁️ Cloud-First Archive:** Generated Markdown and images are published directly to S3; the web app reads the archive manifest and article bodies from object storage.
- **💸 100% Free Architecture:** Replaced legacy metered endpoints with Gemini's generous free tier, assuring massive token executions at zero cost.
- **⏱️ Automated Cadence:** GitHub Actions runs once daily at **9:35 AM America/New_York**, with daylight-saving changes handled by the timezone-aware schedule.

---

## ⚙️ Architecture & Workflow

1. **Trigger:** A scheduled GitHub action kicks off at the configured time from the repository’s default branch.
2. **Compute:** A custom TypeScript runner utilizing `tsx` dynamically generates an extensive academic thesis using the `gemini-2.5-flash` model.
3. **Publish:** The Node.js runner uploads the Markdown object, image object, and a small `posts/index.json` manifest directly to S3.
4. **Delivery:** Astro fetches the lightweight manifest and requested Markdown from S3 at runtime. GitHub stores only the topic-pool state, not generated articles or images.

---

## 🚀 Quick Start Guide

You only need `pnpm` and Node `v24+` to start managing and testing this codebase locally.

<details>
<summary><strong>Environment Setup</strong></summary>
<br>

First, clone the repository and install the strict package configuration:

```bash
pnpm install
```

To run the production pipeline locally, ensure you define the following secrets in a `.env` file (or expose them natively in your terminal session):

```env
# You only need a free key from Google AI Studio.
  GEMINI_API_KEY=your_key_here
  AWS_REGION=us-east-1
  AWS_ACCESS_KEY_ID=your_key
  AWS_SECRET_ACCESS_KEY=your_secret
  S3_BUCKET_NAME=your_bucket
  CONTENT_STORAGE_PUBLIC_BASE_URL=https://your-cdn-or-public-bucket-url
```

</details>

<details>
<summary><strong>Operations console</strong></summary>
<br>

The protected `/dashboard` route uses Neon as the source of truth for users and roles. An `admin` or `operator` can trigger content generation. A `viewer` can inspect the console without changing cloud state.

Only administrators can open the access-control ledger or call the user-management API. Admins can create accounts with an `admin`, `operator`, or `viewer` role. The first administrator is bootstrapped from a trusted terminal; every later account can be created from the console.

For local development, add `DASHBOARD_SESSION_SECRET` and create users directly in Neon:

```env
pnpm run user:create -- --email operator@example.com --password "change-this-password" --role operator
pnpm run user:create -- --email viewer@example.com --password "change-this-password" --role viewer
```

In production, add the cloud and database variables from `.env.example` as GitHub Actions secrets. The site reads post metadata from Neon and article bodies and images from the bucket. New posts publish directly to those cloud services; the repository does not contain a local copy of the archive.

</details>

<a id="observability"></a>

<details>
<summary><strong>Observability</strong></summary>
<br>

The application uses a structured observability pipeline across the browser, Astro API routes, Neon, scheduled generation scripts, and generation controls. Every API request receives an `X-Request-ID`; unexpected failures return that ID to the caller while sensitive values are redacted from logs. Background jobs also install process-level handlers for uncaught exceptions and unhandled promise rejections.

Logs are emitted as JSON to stdout/stderr, which is the durable baseline for Vercel and GitHub Actions. To forward the same events to an external collector, configure the optional HTTPS sink:

The same redacted events are also persisted to Neon in the idempotently-created `application_logs` table. `LOG_DATABASE_URL` can point to a dedicated Neon connection string; when omitted, the logger uses `DATABASE_URL` and then `DIRECT_DATABASE_URL`. The table includes indexed timestamps, service/level pairs, request IDs, and JSONB event metadata.

Generation uploads each Markdown article and image directly to S3 and upserts its metadata into Neon. The site reads the archive from those cloud services; post content and post images are not stored in this repository.

```env
LOG_DATABASE_URL=postgresql://...
LOG_INGEST_URL=https://your-log-collector.example/ingest
LOG_INGEST_TOKEN=your-ingest-token
```

The collector receives request lifecycle events, slow Neon queries, provider failures, authentication/session failures, server exceptions, browser crashes, and unhandled promise rejections. Remote delivery is asynchronous and best-effort so a logging provider outage cannot take down the application. Never place API keys, database URLs, passwords, cookies, or session secrets in log fields; the logger redacts matching fields automatically.

</details>

---

## 🤖 Production Deployment

The stack publishes generated articles and images directly to S3 and stores searchable metadata in Neon. Configure the GitHub repository secrets before enabling the scheduled generation workflow.
To deploy, you **must populate your GitHub Repository Secrets**:

Go to `Settings` > `Secrets and variables` > `Actions` and configure the exact variables required by the [`Environment Setup`](#environment-setup) above.

Once configured, the scheduled workflow publishes new posts directly to S3 and Neon without creating a commit or triggering a Vercel deployment. The topic pool is seeded once from `config/topics.json` and then maintained in Neon. You can also trigger post generation or topic replenishment manually using the `workflow_dispatch` button in the **Actions** tab.

---

<div align="center">
  <p>
    Built for uncompromising technological growth.
  </p>
</div>

---

## 📜 License

This project utilizes a **dual-license** structure due to the hybrid nature of containing both software infrastructure and creative content:

### 1. Software Codebase (`MIT License`)

All software infrastructure, including the Astro frontend, GitHub Actions workflows, TypeScript generation scripts, and system architecture configurations are licensed under the **MIT License**.

You are free to use, modify, distribute, and commercialize the software codebase, provided that you include the original copyright and permission notice.

### 2. Generated Content (`CC BY 4.0`)

All AI-generated technical blogs, essays, and deep-dive articles published in the cloud archive are licensed under **Creative Commons Attribution 4.0 International (CC BY 4.0)**.

You are free to share (copy and redistribute the material in any medium or format) and adapt (remix, transform, and build upon the material) for any purpose, even commercially. However, **you must give appropriate credit (attribution)**, provide a link to the license, and indicate if changes were made. You may do so in any reasonable manner, but not in any way that suggests the licensor endorses you or your use.
