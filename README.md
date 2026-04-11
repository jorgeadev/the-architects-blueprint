<div align="center">

# 📚 Daily Learning Pipeline

**An Uncompromising, Automated Digest of Advanced Computing Paradigms.**

<br />

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-24-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![OpenAI](https://img.shields.io/badge/OpenAI_GPT--4o-412991?style=for-the-badge&logo=openai&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=github-actions&logoColor=white)
![License](https://img.shields.io/badge/License-ISC-blue?style=for-the-badge)

<p align="center">
  <em>A serverless, precision-engineered learning conduit delivering rigorous, thesis-level insights into backend architectures, distributed systems, and infrastructure straight to your inbox and phone.</em>
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

- **🧠 Deep-Dive Epistemology:** Leverages **GPT-4o** to generate highly structured, 20-35 minute long thesis-quality reading sessions every day.
- **⚡ Dual-Channel Routing:** Simultaneously dispatches high-volume text to email (via **SendGrid**) and instant notifications to SMS (via **Twilio**).
- **⏱️ Automated Cadence:** Powered by a robust **GitHub Actions** cron scheduler configured natively for UTC 14:00 (10 AM EST).
- **🛠️ Offline Fallback:** Fully operational local simulation framework to test behaviors and outputs without hitting external, metered API costs.

---

## ⚙️ Architecture & Workflow

1. **Trigger:** A scheduled GitHub action kicks off at the configured time.
2. **Compute:** A custom TypeScript runner utilizing `tsx` dynamically generates an extensive academic thesis using OpenAI.
3. **Dispatch:**
   - **SendGrid Mailer:** Packages the thousands of words into an elegant email template.
   - **Twilio Dispatcher:** Fires a brief "ready to read" SMS to signal the recipient.
4. *(Planned)* **Archiving:** Commits the daily generated `.md` files directly back to the repository for long-term historical browsing.

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
OPENAI_API_KEY=sk-...
SENDGRID_API_KEY=SG....
TWILIO_SID=AC...
TWILIO_AUTH=...

FROM_EMAIL=your-verified-email@example.com
TO_EMAIL=your-personal-inbox@example.com
FROM_PHONE=+1...
TO_PHONE=+1...
```
</details>

<details>
<summary><strong>Local Simulation</strong></summary>
<br>

To preview the formatting and execute the pipeline **without triggering any actual API expenses**, use the sandbox runner:

```bash
pnpm run local
```

This bypasses OpenAI, Twilio, and SendGrid, instead printing a mock thesis response locally to your console.
</details>

---

## 🤖 Production Deployment

The entire stack is configured to run in the cloud automatically.
To deploy, you **must populate your GitHub Repository Secrets**:

Go to `Settings` > `Secrets and variables` > `Actions` and configure the exact variables required by the [`Environment Setup`](#environment-setup) above. 

Once configured, the agent will begin delivering learning documents automatically on schedule. You can also trigger the workflow manually using the `workflow_dispatch` button in the **Actions** tab.

---

<div align="center">
  <p>
    Built for uncompromising technological growth.
  </p>
</div>
