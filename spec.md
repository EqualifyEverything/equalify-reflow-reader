# Equalify Reflow Reader 
This product requirements document is intended to be used as a starting point for an AI-genereated bookmarklet. The team has access to Claude, Gemini, and ChatGPT.

## Requirements
- Platform agnositc; multi-platform 
- Mobile compatibility
- Screen-reader compatibility is a top priority
- Send and recieve data from the [Equalify Reflow API](https://reflow.equalify.uic.edu/docs)
- Data recieved should remain separate from the original document
- Data presented to the user should be HTML (not markdown)
- One PDF should be processed and interacted with at a time
- The product should be able to interact with PDFs with publicly available URLs
- The desired product is a bookmarklet that is easily wrapped into a chrome extension or other browser extensions

## Desired Requirements
- The user may interact with the remediated/altered/accessible PDF and any changes should be saved back to PDF. The resulting PDF does not need to be accessible; the original PDF should retain the data that the user entered without additional accessibility remediations. 
- If the PDF is local, the PDF should be uploaded to some service to create a publicly available URL. This URL can then be used by the Equalify Reflow API.

## User Workflow: User initiated
- User pulls up a PDF.
- User triggers the bookmarklet on the PDF currently in the browser bar. This PDF will be exisiting on the web (stetch: or a local document).
- Bookmarklet may clean the PDF URL to remove anything extraneous (added by Acrobat or extensions).
- A new window or tab is opened with a page title that indicates that the PDF is (or being) remediated/altered/accessible. A loading/processing page is initially shown.
- Equalify Reflow API is called and begins processing the PDF.
- If PII (personally identifiable information) is identified, user is asked if they wish to continue.
- If the user wishes to continue, Equalify Reflow finishes processing the document and returns markdown. If a form is a present, the markdown will include HTML forms.
- The markdown is translated to HTML to present to the user.
- The user will interact with the document HTML. They may simply read the document or they may fill out a form. 
- While interacting with the document, the user may provide feedback to Equalify Reflow including information about quality.
- If the user has made changes, they will save their changes as a PDF.  
- The user may close the new window/tab and return to other tasks.