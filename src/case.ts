// The ZIPGO Mobility Case Competition, built in so a new database starts with it (and so Vercel bundles it).
// data/problem-cards.csv and data/crisis-cards.csv hold the same text, for uploading or editing in the console.

import type { CrisisCard, ProblemCard } from "./rules.js";

export const DEFAULT_PROBLEM_CARDS: ProblemCard[] = [
  {
    "number": 1,
    "title": "Build the next affordable urban mobility brand",
    "body": "India's cities are becoming increasingly crowded, and daily commuters struggle with expensive transportation, traffic congestion and unreliable public transport.\n\nYour task: create a new electric mobility startup targeting college students and young working professionals.\n\nYour startup must introduce an electric mobility product or service that:\n• Is affordable and accessible to middle-class consumers.\n• Offers a convenient alternative to autos and cabs for short-distance travel.\n• Has a unique selling point compared to existing electric scooters.\n• Has a sustainable and profitable business model.\n• Can realistically expand to multiple Indian cities.\n\nYour proposal must address six decisions:\n01 What product or service are you launching?\n02 Who is your target audience?\n03 What will you name your brand?\n04 What will be its pricing?\n05 How will you market it and compete with existing brands?\n06 How will you make money?\n\nExpectation: a practical, commercially viable concept with a clear target market, pricing strategy, competitive positioning and revenue model."
  }
];

export const DEFAULT_CRISIS_CARDS: CrisisCard[] = [
  {
    "number": 1,
    "category": "Customer retention and pricing model",
    "title": "The Unrestricted Ride: ZIPGO",
    "body": "ZIPGO operates on a pay-per-minute rental model. Customers pay for a defined riding duration. Once the purchased time expires, the bicycle is expected to stop or safely restrict further use until the customer pays to continue.\n\nHowever, ZIPGO bicycles continue operating after the paid duration has expired. A customer who purchases a ₹100 ride package may continue riding beyond the purchased time without a clear interruption. The company later applies an additional usage charge, for example ₹120 for the extra usage.\n\nCustomers argue that the bicycle should have clearly warned them or prevented further use once their paid time ended. They see the additional charge as unexpected and feel that the system puts them in a trap. Some customers respond by switching to competing rental services.\n\nThe business problem: ZIPGO's current system allows usage to continue after the paid duration expires, creating unexpected charges, customer dissatisfaction and a risk of losing repeat users.\n\nYour challenge: rethink ZIPGO's rental and revenue model. Develop a solution that protects customers from unexpected charges while keeping the business financially sustainable.\n• Technology: how should the bicycle respond when the paid riding duration expires?\n• Pricing: should ZIPGO introduce alerts, a grace period, automatic extensions or a different pricing structure?\n• Customer retention: how will ZIPGO prevent customers from switching to competitors?\n• Revenue: how can the company charge fairly for additional usage without discouraging repeat rides?\n• Financial viability: how can ZIPGO implement the solution across its fleet while controlling costs?\n\nFinal deliverable: a revised business model that improves pricing transparency, protects customer experience, retains users and maintains ZIPGO's profitability."
  }
];
