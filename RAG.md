# Knowra RAG

Knowra answers from your files. It does not train on them. A file is stored once. A question retrieves a few matching passages and the chat model writes from those.

## Storing

When you upload a PDF, a Word file (.doc or .docx), an Excel file (.xls or .xlsx), or an image (JPEG, PNG, WebP, or GIF):

1. The file goes to Cloudinary. MongoDB keeps the name, size, and status.
2. A background job downloads it and reads the text, page by page. A scan with no selectable text is read with OCR (`gpt-4o-mini`, up to 40 pages). An image is one page and is read with that same OCR. A Word file is one page of extracted text. Each non-empty Excel sheet is a page, starting with the sheet name.
3. Each page is split into chunks of about **1,000 characters**, with **200 characters** of overlap. A chunk never crosses a page, so a source can open that page later.
4. Each chunk is turned into a **1,536-number** vector with OpenAI `text-embedding-3-small`.
5. The text, page number, and vector are saved. The document status becomes `ready`.

A short page is one chunk. A long page is several overlapping chunks. Embeddings always use your OpenAI key, even if chat uses another model.

## Retrieval

The chat model does not read the PDF. It only sees a few passages that search picked out.

Storing already turned every chunk into a vector: 1,536 numbers that stand for the meaning of that text. Two passages about the same idea end up pointing in a similar direction, even when they do not share the same words. A question is turned into a vector the same way, with `text-embedding-3-small`, so it can be compared with those stored vectors.

Say `policy.pdf` was stored as three chunks:

| Chunk | Page | Text |
| --- | --- | --- |
| A | 1 | Office hours are 9am to 5pm on weekdays. |
| B | 3 | Returns are accepted within 30 days of delivery. |
| C | 4 | Shipping inside the US takes 3 to 5 business days. |

You ask: “How long do I have to send something back?”

Knowra does not look for the word “returns.” It sends the question to `text-embedding-3-small` and gets back 1,536 numbers. The same call was already made for A, B, and C when the file was stored. Search only compares those lists of numbers.

### How a token becomes a vector

The model does not read a sentence as one blob. It first cuts the text into **tokens**: small pieces it already knows, usually a word or part of a word.

```
"send something back"  →  [send] [something] [back]
```

Each token has a row in a huge table inside the model. That row is a short list of numbers, learned when OpenAI trained the model. A made-up table with 2 numbers instead of the real hundreds:

| Token | Learned numbers |
| --- | --- |
| send | `[0.90, 0.20]` |
| back | `[0.80, 0.30]` |
| returns | `[0.85, 0.25]` |
| office | `[0.10, 0.90]` |
| hours | `[0.20, 0.80]` |

Training is what filled that table. The model read an enormous amount of text and kept adjusting the numbers. Pieces that showed up in the same kinds of sentences were pulled toward each other. “send” and “returns” both showed up around refunds, so their rows ended up close. “office” showed up around opening times, so its row ended up somewhere else. Nobody typed these numbers in by hand.

A chunk is several tokens. The model reads their rows in order and mixes them into **one** list for the whole chunk. That list is the vector Knowra stores. Order matters: the mix for “send back” is not the mix for “back send”. With the toy table, the question’s tokens (`send`, `back`) and chunk B’s token (`returns`) start from similar rows, so the mixed vectors still point a similar way. Chunk A starts from `office` and `hours`, so its mix points elsewhere.

Nothing in Knowra decides that. One number is not labeled “this is about returns.” The whole list is the meaning. A tiny stand-in for the real 1,536 numbers:

| Text | Vector |
| --- | --- |
| How long do I have to send something back? | `[0.80, 0.50, 0.10]` |
| B · Returns are accepted within 30 days | `[0.78, 0.55, 0.12]` |
| A · Office hours are 9am to 5pm | `[0.10, 0.15, 0.90]` |
| C · Shipping takes 3 to 5 business days | `[0.20, 0.70, 0.40]` |

Cosine similarity measures the angle between two vectors. The question and B almost line up, so B scores highest. A points somewhere else, so it scores low. Atlas sorts by that score and keeps the top matches.

Search keeps the closest chunks (up to 8). Here B is first. The chat model then receives only that passage, not the whole PDF:

```
[1] · policy.pdf · page 3
Returns are accepted within 30 days of delivery.

Question: How long do I have to send something back?
```

It answers from that text: you have 30 days. The source is page 3 of `policy.pdf`. Opening it shows that page. Chunks A and C stay in the database and are not sent.

What happens on a question:

1. The question text alone is embedded. The chat model is not involved yet.
2. Atlas Vector Search compares that vector with your chunk vectors using cosine similarity. A higher score means the two vectors point in a more similar direction.
3. Search returns the **8** closest chunks. It only looks at your account. If a file is selected, it only looks inside that file. With no file selected, it looks across the whole library.
4. Those passages are pasted into the prompt, each labeled with the document name and page, in the shape shown above.
5. Your chat model writes the answer from that block. It is told to use only this context. The same chunks are returned as sources, so opening one jumps to that page.

The rest of the file stays in MongoDB. It is not sent to the model on that question.

Short greetings skip this search. A follow-up in the same chat also includes the last few messages, so “what about next year?” can refer to the previous answer. The new question is still embedded and searched on its own.
