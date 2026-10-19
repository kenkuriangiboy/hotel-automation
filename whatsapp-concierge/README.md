# AI WhatsApp concierge

Answers guest questions on the hotel's WhatsApp number, by text or voice note, in the guest's own language, and passes booking requests to staff. Answers come from the hotel's own FAQ through a RAG knowledge base, so the bot doesn't invent facilities or prices. Currently in pilot.

## Flow

![WhatsApp concierge workflow in n8n](../docs/screenshots/whatsapp-concierge-workflow.png)

```mermaid
flowchart LR
    subgraph Verify[One-time: Meta verification]
        G[Webhook GET /whatsapp] --> RW[Respond with<br/>hub.challenge]
    end

    P[Webhook POST /whatsapp<br/>guest message] --> C[Code: extract number,<br/>name, text or audio id;<br/>drop status updates]
    C --> V{Voice note?}
    V -- yes --> D[Get media URL<br/>+ download .ogg] --> T[Groq Whisper<br/>transcription] --> E[Edit Fields:<br/>from · name · text]
    E --> A
    V -- no --> A[AI agent]
    M1[Gemini] -.-> A
    M2[DeepSeek fallback] -.-> A
    MEM[Memory per<br/>phone number] -.-> A
    KB[hotel_faq tool<br/>Supabase pgvector<br/>+ Gemini embeddings] -.-> A
    OP[Structured output<br/>reply · notify_staff · summary] -.-> A
    A -- success --> R[Reply to guest]
    A -- success --> I{notify_staff?}
    I -- true --> S[Staff alert<br/>WhatsApp template]
    A -- error --> F[Fallback reply:<br/>'our team will reply shortly']
```

### RAG knowledge base

```mermaid
flowchart LR
    subgraph Load[Loader workflow, run when the FAQ changes]
        GD[Google Doc<br/>hotel FAQ] --> SP[Split into ~600-char chunks<br/>80 overlap] --> EM[Gemini embeddings<br/>3072 numbers per chunk] --> DB[(Supabase<br/>documents table)]
    end
    subgraph Ask[Every guest question]
        Q[Question] --> QE[Same Gemini<br/>embedding model] --> MD[match_documents:<br/>4 closest chunks] --> AG[Agent answers<br/>only from them]
    end
    DB --- MD
```

**Demo on WhatsApp (sped up 3x):** a guest asks about check-in, asks for the suite price in Malayalam, then requests a suite for 20–22 October.

![WhatsApp concierge demo](../docs/screenshots/whatsapp-concierge-demo.gif)

**Voice notes in French (sped up 4x):** the guest sends voice notes; they are downloaded from WhatsApp, transcribed with Groq Whisper, and answered in French. The request (1 Deluxe room, 5–7 November, 2 guests) is passed to staff.

<img src="../docs/screenshots/whatsapp-concierge-demo-fr.gif" alt="French voice-note demo" width="280">

**The staff alert, as received on the staff phone:**

![Staff booking alert on WhatsApp](../docs/screenshots/staff-alert.png)

## How it works

- **Webhook verification.** Meta checks the URL once with a GET request carrying `hub.challenge`; a separate GET webhook echoes it back. Guest messages then arrive as POST requests on the same path.
- **Filtering.** Meta also sends delivery and read receipts to the webhook. The Code node keeps only text and voice messages and returns an empty result for everything else, which ends the run quietly.
- **The AI agent** follows the rules in its system message: answer only from the FAQ tool, share rates but never confirm availability, and hand complaints and anything it doesn't know to staff.
- **Memory**, keyed by the guest's phone number, keeps the last 10 messages, so a guest can give their dates over several messages.
- **Structured output** makes the agent return three fields. `reply` goes to the guest; `notify_staff` decides whether staff are alerted; `summary` is the one-line request staff receive.
- **Staff alerts** use an approved WhatsApp template, because the hotel is starting that conversation. Replies to guests are free text, allowed inside WhatsApp's 24-hour window after the guest writes.

## Reliability

- Retry on failure, then a fallback model if Gemini is overloaded.
- If both fail, the error output still sends the guest a polite holding message, so nobody is left without a reply.
- AI-written text is inserted with `JSON.stringify(...)`, so quotes or line breaks in a reply can't break the request body.

## Using this export

Import the JSON into n8n, then:
- connect Gemini, DeepSeek, Groq and Supabase credentials
- run `supabase-setup.sql` in your Supabase project (and make sure its Data API is enabled), then load your own FAQ into the `documents` table with a loader workflow (Google Docs → Supabase Vector Store insert, with the same `models/gemini-embedding-001` embeddings)
- set `YOUR_PHONE_NUMBER_ID`, `YOUR_WHATSAPP_TOKEN`, `YOUR_GROQ_API_KEY`, `YOUR_STAFF_NUMBER` and `YOUR_STAFF_PHONE` (better: move the tokens into n8n Header Auth credentials)
- create and get approval for a `staff_booking_alert` template with three parameters (guest name, phone, request)
- adapt the system message to your property
- register `https://<your-n8n-domain>/webhook/whatsapp` as the callback URL in your Meta app and subscribe to `messages`
