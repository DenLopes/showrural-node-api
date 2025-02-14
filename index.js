const Redis = require("ioredis");
const puppeteer = require("puppeteer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const subscriber = new Redis();
const gemini_api_key = process.env.API_KEY;
const googleAI = new GoogleGenerativeAI(gemini_api_key);

subscriber.subscribe("pdf-scraping", (err, count) => {
  if (err) {
    console.error("Failed to subscribe:", err.message);
    return;
  }
  console.log(`Subscribed to ${count} channels`);
});

subscriber.on("message", async (message) => {
  const data = JSON.parse(message);

  try {
    const result = await scrapePdfFromSGA(data.protocol);

    await Redis.set(`pdf-result:${data.job_id}`, JSON.stringify(result));

    Redis.publish(
      "pdf-complete",
      JSON.stringify({
        job_id: data.job_id,
        status: "completed",
        timestamp: Date.now(),
      })
    );
  } catch (error) {
    Redis.publish(
      "pdf-complete",
      JSON.stringify({
        job_id: data.job_id,
        status: "failed",
        error: error.message,
        timestamp: Date.now(),
      })
    );
  }
});

const geminiConfig = {
  temperature: 0.9,
  topP: 1,
  topK: 1,
  maxOutputTokens: 4096,
};

const geminiModel = googleAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  geminiConfig,
});

const nProtocol = `17.120.535-2`;
let browser = null;

async function setupBrowser() {
  browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins",
      "--disable-site-isolation-trials",
      "--disable-hsts",
      "--ignore-certificate-errors",
      "--disable-features=BlockInsecurePrivateNetworkRequests",
      "--allow-running-insecure-content",
      "--http-allowlist=www.sga.pr.gov.br",
    ],
    executablePath: "/usr/bin/chromium-browser",
  });

  const page = await browser.pages().then((pages) => pages[0]);

  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().includes("https://")) {
      request.abort();
    } else {
      request.continue();
    }
  });

  return { page };
}

async function scrapePdfFromSGA() {
  try {
    const { page } = await setupBrowser();

    const client = await page.createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: "./downloads",
    });

    const downloadStarted = new Promise((resolve) => {
      client.on("Page.downloadWillBegin", (event) => {
        resolve(event.url);
      });
    });

    const url =
      "http://www.sga.pr.gov.br/sga-iap/consultarProcessoLicenciamento.do?action=iniciar";
    const response = await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });

    console.log("Current URL:", page.url());
    console.log("Status:", response.status());

    await page.waitForSelector("#txtNumProtocolo-inputEl", { visible: true });
    await page.type("#txtNumProtocolo-inputEl", nProtocol);
    await page.click("#botaoPesquisar_consultarProcessoLicenciamentoGrid");

    await page.waitForSelector(".x-grid-cell-gridcolumn-1035 a");
    await page.click(".x-grid-cell-gridcolumn-1035 a");

    await page.waitForSelector("#btnPesquisarGeradorResiduo-btnEl");
    await page.click("#btnPesquisarGeradorResiduo-btnEl");

    await page.waitForSelector("#gera_captcha");

    const imgSrc = await page.evaluate(() => {
      const img = document.querySelector("#gera_captcha");
      return img.src;
    });

    let captchaText = await analyzeImageWithGemini(imgSrc);
    captchaText = captchaText.replace(/[^a-zA-Z0-9]/g, "");

    await page.type("#captchaDigitada-inputEl", captchaText);

    // Click continue and wait for the download to start
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const continueButton = buttons.find((button) =>
        button.querySelector("span")?.textContent.includes("Continuar")
      );
      if (continueButton) continueButton.click();
    });

    // Wait a moment for the download to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get the downloaded file and convert to base64
    const files = await fs.promises.readdir("./downloads");
    const pdfPath = path.join("./downloads", files[0]);
    const pdfBuffer = await fs.promises.readFile(pdfPath);
    const pdfBase64 = pdfBuffer.toString("base64");

    const condicionamento = await analyzeGeminiWithGemini(pdfBase64);

    // Clean up downloaded file
    await fs.promises.unlink(pdfPath);

    return {
      success: true,
      message: "Scraping completed",
      data: {
        pdfBase64,
        condicionamento: condicionamento,
      },
    };
  } catch (error) {
    console.error("Scraping error:", error);
    throw new Error(`Scraping failed: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function analyzeImageWithGemini(base64Image) {
  try {
    const imageData = base64Image.replace(/^data:image\/[a-z]+;base64,/, "");

    const prompt = {
      contents: [
        {
          parts: [
            {
              text: "What text or numbers do you see in this CAPTCHA image? respond only the characters you see without spaces.",
            },
            {
              inline_data: {
                mime_type: "image/jpeg",
                data: imageData,
              },
            },
          ],
        },
      ],
    };

    const result = await geminiModel.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    console.error("Gemini analysis error:", error);
    throw error;
  }
}

async function analyzeGeminiWithGemini(base64Pdf) {
  try {
    const prompt = {
      contents: [
        {
          parts: [
            {
              text: "Get the text by the end of the pages, that lives on the left side of the signature field. only return th written text correctly formatted, the text we want is not date, it is information about the document, when there is no signature field get the text inside the sector 4 - condicionamento, do not send any 'EM BRANCO' or 'EM BRANCO EM BRANCO' or 'EM BRANCO EM BRANCO EM BRANCO'.",
            },
            {
              inline_data: {
                mime_type: "application/pdf",
                data: base64Pdf,
              },
            },
          ],
        },
      ],
    };

    const result = await geminiModel.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    console.error("Gemini analysis error:", error);
    throw error;
  }
}

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled Rejection:", error);
  setTimeout(() => process.exit(1), 1000);
});
