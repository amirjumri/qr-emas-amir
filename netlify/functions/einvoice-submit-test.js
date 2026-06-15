const crypto = require("crypto");

async function getAccessToken() {
  const body = new URLSearchParams();

  body.append("client_id", process.env.MYINVOIS_CLIENT_ID);
  body.append("client_secret", process.env.MYINVOIS_CLIENT_SECRET);
  body.append("grant_type", "client_credentials");
  body.append("scope", "InvoicingAPI");

  const r = await fetch(
    "https://identity.myinvois.hasil.gov.my/connect/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    }
  );

  const data = await r.json().catch(() => ({}));

  if (!r.ok || !data.access_token) {
    throw new Error("Gagal dapat access token: " + JSON.stringify(data));
  }

  return data.access_token;
}

exports.handler = async () => {
  try {
    const token = await getAccessToken();

    const codeNumber = "INV-TEST-" + Date.now();

    const rawDocument = JSON.stringify({
      _D: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
      _A: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
      _B: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
      Invoice: [
        {
          ID: [{ _: codeNumber }],
          IssueDate: [{ _: new Date().toISOString().slice(0, 10) }],
          IssueTime: [{ _: new Date().toISOString().slice(11, 19) + "Z" }],
          InvoiceTypeCode: [{ _: "01", listVersionID: "1.0" }],
          DocumentCurrencyCode: [{ _: "MYR" }],
          TaxCurrencyCode: [{ _: "MYR" }],

          AccountingSupplierParty: [
            {
              Party: [
                {
                  IndustryClassificationCode: [
                    {
                      _: "32110",
                      name: "Manufacture of jewellery and related articles"
                    }
                  ],
                  PartyIdentification: [
                    { ID: [{ _: "C58039724060", schemeID: "TIN" }] },
                    { ID: [{ _: "202301019252", schemeID: "BRN" }] }
                  ],
                  PostalAddress: [
                    {
                      CityName: [{ _: "KULIM" }],
                      PostalZone: [{ _: "09000" }],
                      CountrySubentityCode: [{ _: "02" }],
                      AddressLine: [
                        {
                          Line: [
                            {
                              _: "3H JALAN BELIBIS TAMAN TUNKU PUTRA"
                            }
                          ]
                        }
                      ],
                      Country: [
                        {
                          IdentificationCode: [
                            {
                              _: "MYS",
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
                      RegistrationName: [{ _: "EMAS AMIR SDN. BHD." }]
                    }
                  ],
                  Contact: [
                    {
                      Telephone: [{ _: "0123456789" }],
                      ElectronicMail: [
                        { _: "perniagaanemasamir@gmail.com" }
                      ]
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
                    { ID: [{ _: "EI00000000010", schemeID: "TIN" }] },
                    { ID: [{ _: "NA", schemeID: "BRN" }] }
                  ],
                  PostalAddress: [
                    {
                      CityName: [{ _: "KULIM" }],
                      PostalZone: [{ _: "09000" }],
                      CountrySubentityCode: [{ _: "02" }],
                      AddressLine: [
                        {
                          Line: [{ _: "GENERAL PUBLIC" }]
                        }
                      ],
                      Country: [
                        {
                          IdentificationCode: [
                            {
                              _: "MYS",
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
                      RegistrationName: [{ _: "GENERAL PUBLIC" }]
                    }
                  ],
                  Contact: [
                    {
                      Telephone: [{ _: "0123456789" }],
                      ElectronicMail: [{ _: "NA" }]
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
                  TaxableAmount: [{ _: 100, currencyID: "MYR" }],
                  TaxAmount: [{ _: 0, currencyID: "MYR" }],
                  TaxCategory: [
                    {
                      ID: [{ _: "E" }],
                      TaxExemptionReason: [
                        {
                          _: "NOT APPLICABLE"
                        }
                      ],
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
              LineExtensionAmount: [{ _: 100, currencyID: "MYR" }],
              TaxExclusiveAmount: [{ _: 100, currencyID: "MYR" }],
              TaxInclusiveAmount: [{ _: 100, currencyID: "MYR" }],
              PayableAmount: [{ _: 100, currencyID: "MYR" }]
            }
          ],

          InvoiceLine: [
            {
              ID: [{ _: "1" }],
              InvoicedQuantity: [{ _: 1, unitCode: "C62" }],
              LineExtensionAmount: [{ _: 100, currencyID: "MYR" }],
              TaxTotal: [
                {
                  TaxAmount: [{ _: 0, currencyID: "MYR" }],
                  TaxSubtotal: [
                    {
                      TaxableAmount: [{ _: 100, currencyID: "MYR" }],
                      TaxAmount: [{ _: 0, currencyID: "MYR" }],
                      TaxCategory: [
                        {
                          ID: [{ _: "E" }],
                          TaxExemptionReason: [
                            {
                              _: "NOT APPLICABLE"
                            }
                          ],
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
                  Description: [{ _: "TEST EMAS AMIR" }]
                }
              ],

              Price: [
                {
                  PriceAmount: [{ _: 100, currencyID: "MYR" }]
                }
              ],
              ItemPriceExtension: [
                {
                  Amount: [{ _: 100, currencyID: "MYR" }]
                }
              ]
            }
          ]
        }
      ]
    });

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
          codeNumber
        }
      ]
    };

    const r = await fetch(
      "https://api.myinvois.hasil.gov.my/api/v1.0/documentsubmissions/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const result = await r.json().catch(() => ({}));

    return {
      statusCode: r.status,
      body: JSON.stringify(
        {
          ok: r.ok,
          status: r.status,
          codeNumber,
          result
        },
        null,
        2
      )
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify(
        {
          ok: false,
          error: String(err?.message || err)
        },
        null,
        2
      )
    };
  }
};