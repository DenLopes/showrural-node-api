const express = require("express");
const puppeteer = require("puppeteer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const gemini_api_key = process.env.API_KEY;
const googleAI = new GoogleGenerativeAI(gemini_api_key);

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

const app = express();
const port = 3001;
let browser = null;

async function setupBrowser() {
  browser = await puppeteer.launch({
    headless: "new",
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

async function scrapePdfFromSGA(numero_protocolo) {
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
    await page.type("#txtNumProtocolo-inputEl", numero_protocolo);
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
    await new Promise((resolve) => {
      downloadStarted;
      setTimeout(resolve, 2000);
    });

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
              text: `**Extract Text from PDF Document**
								1.  **Extract Text Near Signature Field:** If a signature field is present in the document, find the text located to the left of this field. The signature field is the designated area for signatures.  Exclude any dates from this extracted text.
								2.  **Extract Text from 'Condicionamento' Sector (Conditional):** If there is no signature field in the document, extract the text from 'sector 4 - condicionamento'.  Assume 'sector 4 - condicionamento' refers to a clearly marked section within the document.
								3.  **Formatting and Filtering:** For both extraction cases:
    									*   Return the extracted text, preserving its original formatting (line breaks, spacing).
    									*   Remove any leading or trailing whitespace.
    									*   Do not output any of these phrases (or variations with extra whitespace): 'EM BRANCO', 'EM BRANCO EM BRANCO', 'EM BRANCO EM BRANCO EM BRANCO'.
											*   The extracted text is not only a date, it is a a good ammount of information.
											*   Do not extract any text that is only a date, only if the date is part of the large chunk of text.
								4.  **Output:** Return the extracted text only and nothing else.
											`,
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

app.use(express.json());

app.post("/scrape", async (req, res) => {
  try {
    console.log(req.url);
    console.log(req.body);
    console.log(req.body.numero_protocolo);
    const { numero_protocolo } = req.body;
    const scrapedData = await scrapePdfFromSGA(numero_protocolo);
    res.json({ success: true, data: scrapedData });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Error handling
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled Rejection:", error);
  setTimeout(() => process.exit(1), 1000);
});
