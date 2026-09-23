# Knowra RAG

Knowra answers from your files. It does not train on them. A file is stored once. A question finds a few matching passages, and the chat model writes from those passages only.

## Storing

When you upload a PDF, a Word file (.doc or .docx), an Excel file (.xls or .xlsx), or an image (JPEG, PNG, WebP, or GIF):

1. The file goes to Cloudinary. MongoDB keeps the name, size, and status.
2. A background job downloads it and reads the text, page by page. A scan with no selectable text is read with OCR (`gpt-4o-mini`, up to 40 pages). An image is one page and uses that same OCR. A Word file is one page of extracted text. Each non-empty Excel sheet is a page, starting with the sheet name.
3. Each page is cut into chunks of about **1,000 characters**, with **200 characters** of overlap. A chunk never crosses a page, so a source can open that page later. A short page is one chunk. A page of 2,500 characters becomes three overlapping chunks.
4. Each chunk is sent to OpenAI `text-embedding-3-small`, which returns a vector.
5. MongoDB saves one row per chunk: the text, the page number, and the vector. The document status becomes `ready`.

Embeddings always use your OpenAI key, even when chat uses Claude, Gemini, Grok, or another model.

## What a vector is

A vector is one list of numbers that stands for the meaning of a piece of text. Knowra uses lists of exactly **1,536** numbers because that is the size of `text-embedding-3-small`.

The list length does not follow the text length. One letter, one word, a short question, and a 1,000-character chunk all come back as 1,536 numbers. The words change the values inside the list. They do not change how many numbers there are. That fixed length is why a short question can be compared with a long chunk: position 1 lines up with position 1, through position 1,536.

The **1,000** is only where the file is cut. It is the length of the saved text. It is not the vector.

## Tokens

The embedding model does not swallow a sentence as one blob. It first cuts the text into **tokens**, small pieces it already knows, usually a word or part of a word.

```
"send something back"  →  [send] [something] [back]
```

A token is that piece of text. It is not the array of numbers. The array of numbers is the vector.

You do not calculate tokens from the 1,536 numbers. A tokenizer splits the text, and you count the pieces. `text-embedding-3-small` uses OpenAI’s `cl100k_base` tokenizer. A space usually sticks to the following word.

| Text | Tokens |
| --- | --- |
| `a` | 1: `a` |
| `send something back` | 3: `send` · ` something` · ` back` |
| `How long do I have to send something back?` | 10 |

Knowra’s own fallback, when a provider does not report usage, is rougher: about 1 token per 4 characters (`estimateTokens` in `src/services/openai/client.ts`). That 42-character question is 10 real tokens and `ceil(42 / 4) = 11` by the fallback. Chunks are still cut at 1,000 characters, not at a token count.

Each token has a row of numbers inside the model, filled in when OpenAI trained it. The model reads those rows in order and mixes them into the one 1,536-number vector Knowra stores. Order matters: “send back” and “back send” do not become the same list.

Training is what made similar text land close. The model read a huge amount of text and kept adjusting those rows. Pieces that showed up in the same kinds of sentences were pulled toward each other. “send” and “returns” both showed up around refunds, so their rows ended up similar. “office” showed up around opening times, so its row ended up somewhere else. Nobody typed the numbers in. One number is not labeled “this is about returns.” The whole list is the meaning.

Other embedding models use their own size. Knowra does not call them.

| Model | Numbers in one vector |
| --- | --- |
| OpenAI `text-embedding-3-small` (Knowra) | 1,536 |
| OpenAI `text-embedding-3-large` | 3,072 |
| Cohere `embed-v4.0` | 1,536 |
| Google `gemini-embedding-2` | 3,072 |
| Voyage `voyage-4` | 1,024 |

## Who does the work

| Step | Who |
| --- | --- |
| Cut the file into chunks | Knowra API |
| Turn each chunk, and later the question, into 1,536 numbers | OpenAI `text-embedding-3-small` |
| Save the text and the vector | MongoDB |
| Link each new vector to similar vectors | MongoDB Atlas vector index |
| Score the nearby rows and return the closest text | MongoDB Atlas |
| Write the answer from that text | Your chat model |

The chat model never sees the 1,536 numbers. It only reads the text Atlas already picked.

## Retrieval

`policy.pdf` is stored as three rows. Each row has the sentence and its own 1,536 numbers.

| Row | Page | Text |
| --- | --- | --- |
| A | 1 | Office hours are 9am to 5pm on weekdays. |
| B | 3 | Returns are accepted within 30 days of delivery. |
| C | 4 | Shipping inside the US takes 3 to 5 business days. |

You ask: “How long do I have to send something back?”

1. The API sends that question to OpenAI and gets back 1,536 numbers. Nothing is chosen yet.
2. The API asks Atlas for the closest rows in your account. If a file is open, the search stays inside that file. If no file is open, every file you uploaded is allowed.
3. Atlas scores a pair by using all **1,536** numbers. It multiplies position 1 of the question by position 1 of the chunk, position 2 by position 2, and so on, then collapses those products into **one score** from 0 to 1. Atlas does this. Nothing in the app multiplies them by hand. A score near 1 means the lists point the same way. A score near 0 means they do not. The question does not need the word “returns.” “Send something back” and “returns within 30 days” already point a similar way because of how the tokens were trained, so that chunk scores highest. “Office hours” points another way and scores low.
4. Atlas sorts by that score and returns at most **8** rows. Knowra chose 8 (`limit = 8` in `src/services/rag/chat.ts`). It is how many passages may enter the answer. It is not 8 of the 1,536 numbers. Three chunks in the file means all 3 come back. More than 8 means only the 8 highest scores come back. The rest stay in the database.

The chat model then sees the winning text, not the whole file:

```
[1] · policy.pdf · page 3
Returns are accepted within 30 days of delivery.

Question: How long do I have to send something back?
```

It answers: you have 30 days. Opening the source shows page 3.

With 10 chunks, the sorted list might look like this. Only the first 8 are sent:

| Place | Text | Score | Sent? |
| --- | --- | --- | --- |
| 1 | Returns are accepted within 30 days | 0.91 | Yes |
| 2–8 | The next closest passages | lower | Yes |
| 9 | Office hours are 9am to 5pm | 0.22 | No |
| 10 | Shipping takes 3 to 5 days | 0.18 | No |

Short greetings skip this search. A follow-up in the same chat also includes the last few messages. The new question is still turned into its own vector and searched again.

## Why a large library stays fast

A thousand files can mean tens of thousands of chunks. Those chunks are allowed into a library search. They are not all scored.

On each insert, Atlas saves the row and links its vector to similar vectors in the index `chunk_embedding_index`. The rows are not rearranged. The index is the extra structure that remembers which lists sit near each other.

A question follows those links. It gathers about **200** nearby rows (`numCandidates`, which is `limit × 25`), scores those 200, and returns the best 8. The other chunks are skipped for this question and stay stored for a later one. Other accounts are never included.

The 200 is a search setting, not a pile of rows. Asking for 300 winners instead of 8 would not delete anything. The search would have to look at more than 200 rows first, then put 300 passages into the prompt. That answer would be slower and more expensive. The database would be unchanged.

This is vector search. Products such as Pinecone, Qdrant, and Weaviate are separate databases that do the same job. Knowra uses MongoDB Atlas Vector Search, which is that index inside the MongoDB that already stores the chunks.
