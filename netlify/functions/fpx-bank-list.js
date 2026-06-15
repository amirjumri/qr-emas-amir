exports.handler = async () => {

  const banks = [
    { id:"TEST0010", name:"SBI BANK A", status:"A" },
    { id:"TEST0021", name:"SBI BANK A", status:"A" },
    { id:"TEST0022", name:"SBI BANK B", status:"A" },
    { id:"MBB0228", name:"Maybank2U", status:"A" },
    { id:"BCBB0235", name:"CIMB Clicks", status:"A" },
    { id:"RHB0218", name:"RHB Bank", status:"A" }
  ];

  return {
    statusCode: 200,
    headers:{
      "Content-Type":"application/json"
    },
    body: JSON.stringify({
      ok:true,
      exchangeId:"EX00040523",
      sellerId:"SE00120695",
      banks
    })
  };
};