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
    - [Local Simulation](#local-simulation)
- [🤖 Production Deployment](#-production-deployment)
- [📜 License](#-license)

---

## ✨ Core Features

- **🧠 Deep-Dive Epistemology:** Leverages **Google Gemini (2.5 Flash)** to generate highly structured, 20-35 minute long thesis-quality reading sessions every day mapping complex technological landscapes.
- **📂 Auto-Archiving System:** Automatically captures the thousands of words generated, parses dynamic markdown names, and securely saves the document into the `/articles` directory.
- **💸 100% Free Architecture:** Replaced legacy metered endpoints with Gemini's generous free tier, assuring massive token executions at zero cost.
- **⏱️ Automated Cadence:** Powered by a robust **GitHub Actions** cron scheduler configured natively for UTC 14:00 (10 AM ET).
- **🛠️ Offline Fallback:** Fully operational local simulation framework to test behaviors, filesystem hooks, and outputs securely.

---

## ⚙️ Architecture & Workflow

1. **Trigger:** A scheduled GitHub action kicks off at the configured time from the repository’s default branch.
2. **Compute:** A custom TypeScript runner utilizing `tsx` dynamically generates an extensive academic thesis using the `gemini-2.5-flash` model.
3. **Capture:** The Node.js native `fs` layer intercepts the payload, scrapes the thesis title, and writes a `.md` file into the `articles/` directory.
4. **Archiving:** The GitHub Action pipeline wakes up a bot user (`github-actions[bot]`), auto-commits the newly spawned file directly to the repository branch, and pushes the change automatically.

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
```

</details>

<details>
<summary><strong>Local Simulation</strong></summary>
<br>

To preview the formatting and execute the pipeline safely without using real API tokens, use the sandbox runner:

```bash
pnpm run local
```

This bypasses Gemini, instead printing a mock thesis response to your local console and writing a realistic `.md` file to disk in the `articles/` directory.

</details>

---

## 🤖 Production Deployment

The entire stack is configured to run in the cloud automatically.
To deploy, you **must populate your GitHub Repository Secrets**:

Go to `Settings` > `Secrets and variables` > `Actions` and configure the exact variables required by the [`Environment Setup`](#environment-setup) above.

Once configured, the agent will begin delivering and auto-committing learning documents automatically on schedule. You can also trigger the workflow manually using the `workflow_dispatch` button in the **Actions** tab.

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

All AI-generated technical blogs, essays, and deep-dive articles located within the `web/src/content/blog/` directory are licensed under **Creative Commons Attribution 4.0 International (CC BY 4.0)**.

You are free to share (copy and redistribute the material in any medium or format) and adapt (remix, transform, and build upon the material) for any purpose, even commercially. However, **you must give appropriate credit (attribution)**, provide a link to the license, and indicate if changes were made. You may do so in any reasonable manner, but not in any way that suggests the licensor endorses you or your use.
