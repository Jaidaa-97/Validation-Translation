# Translation Validation Tool Demo

## 1. Opening Introduction

Hello everyone. Today I will present my Translation Validation Tool for LHW hotel content.

The purpose of this project is to help validate translated hotel copy from Excel against the real live LHW website. Instead of manually checking every hotel page and every language, this tool automates the process and clearly shows which translations match the website, which ones are missing, and which ones need review.

This is useful because hotel content is spread across many areas of the website, including the overview page, property highlights, hotel features, dining pages, restaurant operation hours, spa pages, local information, and special notices.

## 2. Problem Statement

Before this tool, translation validation was mostly manual.

A reviewer had to open the Excel file, open the hotel website, switch between languages, search for the same content on different pages, and compare the text by eye. This takes a lot of time and can easily lead to human mistakes, especially when there are multiple languages and many hotel sections.

This project solves that problem by automatically reading the Excel file, opening the live website with a browser, collecting the actual website text, and comparing it with the expected translation text.

## 3. Demo Setup

Before starting the demo, make sure the server is running:

```powershell
$env:HEADLESS="false"; $env:PW_CHANNEL="chrome"; npm start
```

Then open the local address shown in the terminal, for example:

```text
http://localhost:3000
```

If port 3000 is busy, the terminal may show another port such as 3001 or 3002.

## 4. Live Demo Flow

### Step 1: Open the Application

Open the local app in the browser.

Say:

This is the main interface of the translation validator. The user can upload an Excel translation file, enter the hotel URL, choose a language, and start the validation.

### Step 2: Upload the Excel File

Choose the translation Excel file.

Say:

The Excel file contains the expected hotel content in different languages. The tool reads the file and only validates rows that have English source content. This avoids checking empty or irrelevant rows and improves performance.

### Step 3: Enter the Hotel URL

Paste a hotel URL from LHW, for example:

```text
https://www.lhw.com/hotel/Lesante-Cape-Zakynthos-Greece?rooms=1&numadult1=2&numchild1=0
```

Say:

The hotel URL is used as the base page. The system can automatically build the correct localized website URL for each language, such as English, German, French, Italian, Spanish, and Japanese.

### Step 4: Choose a Language

Click one language button, such as `ENG` or `GER`.

Say:

The tool supports validating one language at a time. This is useful when I only need to check one translation quickly.

Then point to the `ALL` button.

Say:

There is also an ALL option, which validates all supported languages. When ALL is selected, the tool checks English first as the source baseline. If the English source does not match the live website, the tool stops and asks the user to update the English content before checking other translations.

### Step 5: Start the Validation

Click the run or compare button.

Say:

When I start the validation, old results are cleared immediately. The tool then opens the live LHW website using Playwright, which is a browser automation tool. This is necessary because LHW pages are dynamic and some content only appears after the page loads.

### Step 6: Show Browser Automation

If visible Chrome is open, show that the browser is navigating through the LHW website.

Say:

The browser is not using static HTML. It is visiting the real website like a user. This allows it to capture live content from dynamic pages.

The tool can visit multiple pages depending on the Excel rows, including the hotel overview page, property search results, dining pages, and spa pages.

### Step 7: Explain Live Progress

Point to the status area showing elapsed time or current language.

Say:

The interface shows live progress and elapsed time. This is important because website scraping can take some time, especially when checking multiple languages or pages like dining and spa.

For ALL language validation, results are streamed as each language finishes, so the user does not need to wait until the entire process is complete.

### Step 8: Review the Results

Open a language result section.

Say:

The results are grouped by language. Each row shows the section name, expected text from Excel, actual text from the live website, status, and a note explaining where the content was checked.

The main statuses are:

- Passed means the expected text was found on the live site.
- Not Found means the expected text was not found.
- Failed means the tool could not validate that row because of a selector, page, or extraction issue.
- Skipped means the Excel cell was empty for that language.

### Step 9: Show Property Highlight Validation

Find a property highlight row if available.

Say:

The tool has special logic for property highlights. The website may display titles with numbering like `1 / BUTLER`, but the Excel file may only contain `BUTLER`. The validator removes the visual number prefix before comparing, so it avoids false errors.

### Step 10: Show Hotel Features Validation

Find hotel feature rows if available.

Say:

Hotel features are validated separately because they are structured differently from normal paragraph text. The tool captures the feature section from the live website and checks whether the expected feature text exists.

### Step 11: Show Dining Validation

Find restaurant rows if available.

Say:

Dining content is often located on the `/services-amenities/dining` page, not only on the main hotel overview page. The tool automatically opens the dining page and validates restaurant names, descriptions, and dining copy.

### Step 12: Show Operation Hours Validation

Find an operation hours row if available.

Say:

The validator can also extract restaurant operation hours from the live dining page. It matches the hours to the correct restaurant by using the restaurant name from the Excel rows. This avoids incorrect matching when the order in Excel is different from the order on the website.

For example, if the live website shows `Fiore Fine Dining` with `19:30 - 22:00`, the validator matches those hours to Fiore, not just to restaurant number four.

### Step 13: Show Spa Validation

Find spa rows if available.

Say:

Spa content is handled separately because it is usually on the `/services-amenities/spa` page. The tool captures the spa title and description and compares them with the Excel translation.

### Step 14: Explain Error Handling

Show any Not Found or Failed row if present.

Say:

The tool does not only say pass or fail. It also gives an explanation in the note column. This helps the reviewer understand whether the issue is missing content, a mismatch, or a page extraction problem.

## 5. Key Features Summary

- Upload Excel translation files.
- Validate only rows with English source content.
- Compare Excel copy against the live LHW website.
- Support individual languages and ALL language validation.
- Build localized hotel URLs automatically.
- Use Playwright to capture dynamic website content.
- Validate hotel overview content.
- Validate property search descriptions.
- Validate property highlight titles and descriptions.
- Remove visual ordinal prefixes from highlight titles.
- Validate hotel features separately.
- Validate dining page content.
- Validate restaurant operation hours.
- Match operation hours by restaurant name.
- Validate spa page title and description.
- Validate local information and notices when present.
- Stream results per language as soon as they are ready.
- Show expandable result sections by language.
- Show execution time and progress.
- Stop ALL language validation if English source content is outdated.
- Clean uploaded files after the run.

## 6. Technical Explanation

The backend is built with Node.js and Express.

The Excel file is uploaded using Multer and read using the `xlsx` package.

Playwright is used to open the real LHW website in Chrome, wait for dynamic content, and extract text from the relevant pages.

The server streams validation events back to the frontend using NDJSON, so the UI can update while the validation is still running.

The frontend displays results in expandable language sections and shows status, expected text, actual text, notes, and execution time.

## 7. Closing Statement

To conclude, this project improves the translation validation workflow by making it faster, more consistent, and easier to review.

Instead of manually checking many pages and languages, the user can upload the translation sheet, choose a hotel and language, and receive structured validation results directly from the live website.

This reduces manual effort, improves quality control, and helps ensure that translated hotel content is accurate before or after it is published.

