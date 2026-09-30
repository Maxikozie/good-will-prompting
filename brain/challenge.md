# The SD Worx challenge

## Problem statement (slide, verbatim)
> **How might we turn fragmented organisational knowledge into a trusted shared resource?**
>
> Build a focused proof of concept that makes knowledge easier to: **FIND** · **TRUST** · **SHARE**
>
> Choose a focused problem. You do not need to solve everything.

## What they explicitly don't want
- **"A SharePoint with a search function."**
- **"Another AI agent."**

Their reason: they already have both, and the problem still exists.

## The core problem
SD Worx has a lot of knowledge, but it's spread everywhere:
- Documents, manuals, checklists
- SharePoint sites
- MS Teams channels and chats
- Old emails
- **Tacit knowledge in people's heads**: never documented

The company grew from a few customers and a few tools in Antwerp, where everyone knew who to ask, to 30 countries and 10,000 colleagues. Nobody knows who to ask anymore, or which document to trust.

## Real-life examples (from the slide + talk)

### 1. Urgent customer question: "which document do I trust?"
- A customer calls, usually with an employee question. It's urgent. The employee needs a reliable answer **now**.
- The colleague on the phone asks their existing AI assistant, which returns **3 documents**:
  1. One **without an owner**. Nobody knows who wrote it.
  2. One **edited recently** (last week). Is that the most up-to-date one?
  3. One with the right title, but it **may apply to another country**.
- Then a colleague pings: "I heard what you're looking for, I'll email you the documents", pointing to an **MS Teams chat with different information**.
- Result: 4 sources, conflicting, and no way to tell which is right while the customer waits.

### 2. Consultant handover: "who do I call?"
- A payroll consultant takes over a client portfolio from a colleague (the speaker's own example: getting Nike as a client).
- **2010:** one Word document for knowledge sharing + a ~30–60 min talk with a colleague, and you knew everything you needed.
- **2026:** the client is in multiple countries, uses many SD Worx tools and works with many teams. You don't know who to call or which document to trust.
- The slide ends with **"2026: …"**. They want us to fill that in.

## Possible directions (slide: "Use these questions as inspiration, not as a checklist")
| Theme | Question |
|---|---|
| **Trust** | How can people know whether information is relevant and reliable? |
| **Capture** | How can valuable knowledge be made accessible beyond inboxes, documents or individual teams? |
| **Detect** | How can conflicting information or missing knowledge be identified? |
| **Connect** | How can people find the right expertise when documents are not enough? |

## Our read (interpretation, not from the brief)
- The **trust** signals are already named in example 1: **owner**, **freshness**, **country/scope**, and **conflicts between sources**. A PoC that makes those visible and decides between conflicting sources answers the brief directly. A plain search box or chatbot does not.
- "Connect" + example 2 hint at **routing to people** (who is the expert, who owned this client before), not only documents.
- Pick **one** of the two examples as the demo story. Judges asked for focus.
- Everything can run on **mock data**: a handful of fake docs, Teams messages, emails and people for one fictional client, deliberately containing conflicts.
