const WS='/home/guoj01/agents/pi_csp_agent_v3';const ExcelJS=require('exceljs');
(async()=>{const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(WS+'/output/CSP_Leads_Report.xlsx');
const ws=wb.getWorksheet('全部商机');const h=ws.getRow(1).values;const c=k=>h.indexOf(k);
ws.eachRow((r,n)=>{if(n<2)return;const nm=String(r.getCell(c('产品名称')).value||'');
 if(/Colistimethate|美罗培南普莱巴坦|氨氯地平阿托伐他汀/.test(nm))
  console.log('  '+nm.slice(0,28).padEnd(30)+'| '+String(r.getCell(c('药物分类')).value).padEnd(12)+'| 注册='+String(r.getCell(c('注册分类')).value||'-').padEnd(5)+'| '+String(r.getCell(c('分类依据')).value));});})();
