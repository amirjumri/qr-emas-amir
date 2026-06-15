const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SB_URL = process.env.SUPABASE_URL || "https://dduizetstqqjrpsezbpi.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const MYINVOIS_IDENTITY_URL =
  process.env.MYINVOIS_IDENTITY_URL ||
  "https://identity.myinvois.hasil.gov.my/connect/token";

const MYINVOIS_SUBMIT_URL =
  process.env.MYINVOIS_SUBMIT_URL ||
  "https://api.myinvois.hasil.gov.my/api/v1.0/documentsubmissions/";

const SUPPLIER = {
  name: "EMAS AMIR SDN. BHD.",
  tin: "C58039724060",
  brn: "202301019252",
  msic: "32110",
  msicName: "Manufacture of jewellery and related articles",
  address: "3H JALAN BELIBIS TAMAN TUNKU PUTRA",
  city: "KULIM",
  postcode: "09000",
  stateCode: "02",
  country: "MYS",
  phone: "0168055916",
  email: "perniagaanemasamir@gmail.com"
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body, null, 2)
  };
}

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function issueTime() {
  return new Date().toISOString().slice(11, 19) + "Z";
}

function clean(v) {
  return String(v || "").trim();
}

function onlyDigit(v) {
  return String(v || "").replace(/\D/g, "");
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(num(n) * 100) / 100;
}

function safePhone(v) {
  const x = onlyDigit(v);
  if (!x) return "0123456789";
  if (x.startsWith("60")) return "+" + x;
  if (x.startsWith("0")) return "+6" + x;
  return "+" + x;
}

function stateCodeMY(state) {
  const s = clean(state).toLowerCase();

  if (s.includes("johor")) return "01";
  if (s.includes("kedah")) return "02";
  if (s.includes("kelantan")) return "03";
  if (s.includes("melaka") || s.includes("malacca")) return "04";
  if (s.includes("negeri")) return "05";
  if (s.includes("pahang")) return "06";
  if (s.includes("pulau pinang") || s.includes("penang")) return "07";
  if (s.includes("perak")) return "08";
  if (s.includes("perlis")) return "09";
  if (s.includes("selangor")) return "10";
  if (s.includes("terengganu")) return "11";
  if (s.includes("sabah")) return "12";
  if (s.includes("sarawak")) return "13";
  if (s.includes("kuala lumpur")) return "14";
  if (s.includes("labuan")) return "15";
  if (s.includes("putrajaya")) return "16";

  return "02";
}

function getTotalRM(order) {
  const grand = num(order.grand_total_rm);
  if (grand > 0) return round2(grand);

  const cents = num(order.amount_cents);
  if (cents > 0) return round2(cents / 100);

  const sub = num(order.subtotal_rm);
  const ship = num(order.shipping_rm);
  const payDisc = num(order.pay_disc_rm);
  const couponDisc = num(order.coupon_disc_rm);
  const calc = sub + ship - payDisc - couponDisc;
  if (calc > 0) return round2(calc);

  const unit = num(order.unit_rm);
  const qty = num(order.qty, 1);
  return round2(unit * qty);
}

async function getAccessToken() {
  const clientId = process.env.MYINVOIS_CLIENT_ID;
  const clientSecret = process.env.MYINVOIS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("MYINVOIS_CLIENT_ID / MYINVOIS_CLIENT_SECRET belum set.");
  }

  const body = new URLSearchParams();
  body.append("client_id", clientId);
  body.append("client_secret", clientSecret);
  body.append("grant_type", "client_credentials");
  body.append("scope", "InvoicingAPI");

  const r = await fetch(MYINVOIS_IDENTITY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok || !data.access_token) {
    throw new Error("Gagal dapat access token: " + JSON.stringify(data));
  }

  return data.access_token;
}

function buildCustomer(order, customer) {
  const name =
    clean(customer?.name) ||
    clean(customer?.customer_name) ||
    clean(order.customer_name) ||
    "GENERAL PUBLIC";

  const ic = onlyDigit(customer?.ic);
  const phone = clean(customer?.phone) || clean(order.phone) || "0123456789";

  const address =
    clean(order.shipping_address1) ||
    clean(customer?.alamat) ||
    "GENERAL PUBLIC";

  const postcode =
    clean(order.postcode) ||
    clean(customer?.postcode) ||
    "09000";

  const city =
    clean(order.city) ||
    clean(customer?.city) ||
    "KULIM";

  const state =
    clean(order.state) ||
    clean(customer?.state) ||
    "Kedah";

  const phoneDigits = onlyDigit(
  customer?.phone ||
  order?.phone ||
  "0123456789"
);

const email =
  clean(customer?.email) ||
  `${phoneDigits}@emasamir.app`;

  return {
    name,
    tin: "EI00000000010",
    idScheme: ic ? "NRIC" : "BRN",
    idValue: ic || "NA",
    phone: safePhone(phone),
    email,
    address,
    postcode,
    city,
    stateCode: stateCodeMY(state),
    country: "MYS"
  };
}

function buildInvoiceDocument(order, customer) {
  const total = getTotalRM(order);
  const codeNumber = "J916-" + clean(order.order_code || String(order.reference || "").slice(0, 8));

  const itemDesc = [
    clean(order.code),
    clean(order.name) || "Barang Kemas 916",
    num(order.weight_g) ? `${num(order.weight_g).toFixed(2)}g` : ""
  ].filter(Boolean).join(" • ");

  const buyer = buildCustomer(order, customer);

  const doc = {
    _D: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
    _A: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    _B: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    Invoice: [
      {
        ID: [{ _: codeNumber }],
        IssueDate: [{ _: todayDate() }],
        IssueTime: [{ _: issueTime() }],
        InvoiceTypeCode: [{ _: "01", listVersionID: "1.0" }],
        DocumentCurrencyCode: [{ _: "MYR" }],
        TaxCurrencyCode: [{ _: "MYR" }],

        AccountingSupplierParty: [
          {
            Party: [
              {
                IndustryClassificationCode: [
                  {
                    _: SUPPLIER.msic,
                    name: SUPPLIER.msicName
                  }
                ],
                PartyIdentification: [
                  { ID: [{ _: SUPPLIER.tin, schemeID: "TIN" }] },
                  { ID: [{ _: SUPPLIER.brn, schemeID: "BRN" }] }
                ],
                PostalAddress: [
                  {
                    CityName: [{ _: SUPPLIER.city }],
                    PostalZone: [{ _: SUPPLIER.postcode }],
                    CountrySubentityCode: [{ _: SUPPLIER.stateCode }],
                    AddressLine: [
                      {
                        Line: [{ _: SUPPLIER.address }]
                      }
                    ],
                    Country: [
                      {
                        IdentificationCode: [
                          {
                            _: SUPPLIER.country,
                            listID: "ISO3166-1",
                            listAgencyID: "6"
                          }
                        ]
                      }
                    ]
                  }
                ],
                PartyLegalEntity: [
                  {
                    RegistrationName: [{ _: SUPPLIER.name }]
                  }
                ],
                Contact: [
                  {
                    Telephone: [{ _: safePhone(SUPPLIER.phone) }],
                    ElectronicMail: [{ _: SUPPLIER.email }]
                  }
                ]
              }
            ]
          }
        ],

        AccountingCustomerParty: [
          {
            Party: [
              {
                PartyIdentification: [
                  { ID: [{ _: buyer.tin, schemeID: "TIN" }] },
                  { ID: [{ _: buyer.idValue, schemeID: buyer.idScheme }] }
                ],
                PostalAddress: [
                  {
                    CityName: [{ _: buyer.city }],
                    PostalZone: [{ _: buyer.postcode }],
                    CountrySubentityCode: [{ _: buyer.stateCode }],
                    AddressLine: [
                      {
                        Line: [{ _: buyer.address }]
                      }
                    ],
                    Country: [
                      {
                        IdentificationCode: [
                          {
                            _: buyer.country,
                            listID: "ISO3166-1",
                            listAgencyID: "6"
                          }
                        ]
                      }
                    ]
                  }
                ],
                PartyLegalEntity: [
                  {
                    RegistrationName: [{ _: buyer.name }]
                  }
                ],
                Contact: [
                  {
                    Telephone: [{ _: buyer.phone }],
                    ElectronicMail: [{ _: buyer.email || "NA" }]
                  }
                ]
              }
            ]
          }
        ],

        TaxTotal: [
          {
            TaxAmount: [{ _: 0, currencyID: "MYR" }],
            TaxSubtotal: [
              {
                TaxableAmount: [{ _: total, currencyID: "MYR" }],
                TaxAmount: [{ _: 0, currencyID: "MYR" }],
                TaxCategory: [
                  {
                    ID: [{ _: "E" }],
                    TaxExemptionReason: [{ _: "NOT APPLICABLE" }],
                    TaxScheme: [
                      {
                        ID: [
                          {
                            _: "OTH",
                            schemeID: "UN/ECE 5153",
                            schemeAgencyID: "6"
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ],

        LegalMonetaryTotal: [
          {
            LineExtensionAmount: [{ _: total, currencyID: "MYR" }],
            TaxExclusiveAmount: [{ _: total, currencyID: "MYR" }],
            TaxInclusiveAmount: [{ _: total, currencyID: "MYR" }],
            PayableAmount: [{ _: total, currencyID: "MYR" }]
          }
        ],

        InvoiceLine: [
          {
            ID: [{ _: "1" }],
            InvoicedQuantity: [{ _: 1, unitCode: "C62" }],
            LineExtensionAmount: [{ _: total, currencyID: "MYR" }],
            TaxTotal: [
              {
                TaxAmount: [{ _: 0, currencyID: "MYR" }],
                TaxSubtotal: [
                  {
                    TaxableAmount: [{ _: total, currencyID: "MYR" }],
                    TaxAmount: [{ _: 0, currencyID: "MYR" }],
                    TaxCategory: [
                      {
                        ID: [{ _: "E" }],
                        TaxExemptionReason: [{ _: "NOT APPLICABLE" }],
                        TaxScheme: [
                          {
                            ID: [
                              {
                                _: "OTH",
                                schemeID: "UN/ECE 5153",
                                schemeAgencyID: "6"
                              }
                            ]
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ],
            Item: [
              {
                CommodityClassification: [
                  {
                    ItemClassificationCode: [
                      {
                        _: "022",
                        listID: "CLASS"
                      }
                    ]
                  }
                ],
                Description: [{ _: itemDesc || "BARANG KEMAS 916" }]
              }
            ],
            Price: [
              {
                PriceAmount: [{ _: total, currencyID: "MYR" }]
              }
            ],
            ItemPriceExtension: [
              {
                Amount: [{ _: total, currencyID: "MYR" }]
              }
            ]
          }
        ]
      }
    ]
  };

  return {
    codeNumber,
    doc,
    buyer,
    total
  };
}

async function findCustomer(sb, order) {
  if (order.customer_id) {
    const { data } = await sb
      .from("customers")
      .select("*")
      .eq("id", order.customer_id)
      .maybeSingle();

    if (data) return data;
  }

  const phone = onlyDigit(order.phone);
  const variants = new Set();

  if (phone) variants.add(phone);
  if (phone.startsWith("60")) variants.add("0" + phone.slice(2));
  if (phone.startsWith("0")) variants.add("60" + phone.slice(1));

  const list = Array.from(variants).filter(Boolean);

  if (list.length) {
    const { data } = await sb
      .from("customers")
      .select("*")
      .in("phone", list)
      .limit(1);

    if (data && data[0]) return data[0];
  }

  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, {
      ok: false,
      message: "Method tidak dibenarkan. Guna POST."
    });
  }

  if (!SB_KEY) {
    return json(500, {
      ok: false,
      message: "SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY belum set."
    });
  }

  const sb = createClient(SB_URL, SB_KEY);

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return json(400, {
      ok: false,
      message: "Body JSON tidak sah."
    });
  }

  const orderCode = clean(body.order_code);
  if (!orderCode) {
    return json(400, {
      ok: false,
      message: "order_code wajib ada."
    });
  }

  try {
    const { data: order, error: orderErr } = await sb
      .from("j916_orders")
      .select("*")
      .eq("order_code", orderCode)
      .maybeSingle();

    if (orderErr) throw orderErr;

    if (!order) {
      return json(404, {
        ok: false,
        message: "Order tidak dijumpai.",
        order_code: orderCode
      });
    }

    if (String(order.status || "").toUpperCase() !== "PAID") {
      return json(400, {
        ok: false,
        message: "Order belum PAID.",
        order_code: orderCode,
        status: order.status
      });
    }

    if (String(order.einvoice_status || "").toUpperCase() === "VALID") {
      return json(200, {
        ok: true,
        message: "Order ini sudah ada e-Invoice VALID.",
        result: {
          submissionUid: order.einvoice_submission_uid,
          acceptedDocuments: [
            {
              uuid: order.einvoice_uuid,
              longId: order.einvoice_long_id,
              invoiceCodeNumber: order.einvoice_code_number
            }
          ]
        }
      });
    }

    const customer = await findCustomer(sb, order);
    const built = buildInvoiceDocument(order, customer);

    const rawDocument = JSON.stringify(built.doc);

    const documentBase64 = Buffer
      .from(rawDocument, "utf8")
      .toString("base64");

    const documentHash = crypto
      .createHash("sha256")
      .update(rawDocument, "utf8")
      .digest("hex");

    const payload = {
      documents: [
        {
          format: "JSON",
          document: documentBase64,
          documentHash,
          codeNumber: built.codeNumber
        }
      ]
    };

    await sb
      .from("j916_orders")
      .update({
        einvoice_mode: "INDIVIDUAL",
        einvoice_status: "SUBMITTED",
        einvoice_code_number: built.codeNumber,
        einvoice_payload: {
          source: "J916",
          order_code: orderCode,
          total_rm: built.total,
          buyer: built.buyer,
          submit_payload: payload
        },
        einvoice_error: null,
        einvoice_submitted_at: nowIso(),
        einvoice_updated_at: nowIso()
      })
      .eq("order_code", orderCode);

    const token = await getAccessToken();

    const r = await fetch(MYINVOIS_SUBMIT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await r.json().catch(() => ({}));

    if (!r.ok) {
      await sb
        .from("j916_orders")
        .update({
          einvoice_mode: "INDIVIDUAL",
          einvoice_status: "FAILED",
          einvoice_error: result,
          einvoice_updated_at: nowIso()
        })
        .eq("order_code", orderCode);

      return json(r.status || 400, {
        ok: false,
        message: "Submit MyInvois gagal.",
        order_code: orderCode,
        codeNumber: built.codeNumber,
        result
      });
    }

    const accepted = Array.isArray(result.acceptedDocuments)
      ? result.acceptedDocuments[0]
      : null;

    const rejected = Array.isArray(result.rejectedDocuments)
      ? result.rejectedDocuments[0]
      : null;

    if (rejected && !accepted) {
      await sb
        .from("j916_orders")
        .update({
          einvoice_mode: "INDIVIDUAL",
          einvoice_status: "FAILED",
          einvoice_submission_uid: result.submissionUid || null,
          einvoice_error: result,
          einvoice_updated_at: nowIso()
        })
        .eq("order_code", orderCode);

      return json(400, {
        ok: false,
        message: "MyInvois reject document.",
        order_code: orderCode,
        codeNumber: built.codeNumber,
        result
      });
    }

    await sb
      .from("j916_orders")
      .update({
        einvoice_mode: "INDIVIDUAL",
        einvoice_status: "VALID",
        einvoice_submission_uid: result.submissionUid || null,
        einvoice_uuid: accepted?.uuid || null,
        einvoice_long_id: accepted?.longId || null,
        einvoice_code_number: accepted?.invoiceCodeNumber || built.codeNumber,
        einvoice_payload: result,
        einvoice_error: null,
        einvoice_validated_at: nowIso(),
        einvoice_updated_at: nowIso()
      })
      .eq("order_code", orderCode);

    return json(200, {
      ok: true,
      message: "E-Invoice J916 berjaya submit.",
      order_code: orderCode,
      codeNumber: built.codeNumber,
      result
    });

  } catch (err) {
    try {
      await sb
        .from("j916_orders")
        .update({
          einvoice_mode: "INDIVIDUAL",
          einvoice_status: "FAILED",
          einvoice_error: {
            message: String(err?.message || err)
          },
          einvoice_updated_at: nowIso()
        })
        .eq("order_code", orderCode);
    } catch (_) {}

    return json(500, {
      ok: false,
      message: String(err?.message || err),
      order_code: orderCode
    });
  }
};