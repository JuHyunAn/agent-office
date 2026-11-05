import { polygon, line } from '../pixel-office/raster.js';

// 승인된 소도시 시안의 좌표와 배율을 유지한다.
const W=1600,H=1120,S=.82,OX=100,OY=140,G=-156;
export const VIEW=Object.freeze({width:W*2,height:H*2,scale:S,x:OX*2,y:OY*2});
let cached=null,frame=null;
const canvas=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
const OFFICE_BLOCKS=[{x:32,y:64,w:2056,d:1136},{x:32,y:1360,w:672,d:440},{x:1592,y:1360,w:496,d:400}];

// 사무실에 가려질 뒤쪽 요소와 사무실보다 가까운 요소를 구분한다.
export function isOfficeForeground({x,y,w=0,d=0}){
 const origin=780*S+OX,step=.36*S;
 const left=origin+(x-y-d)*step-24,right=origin+(x+w-y)*step+24;
 const overlapping=OFFICE_BLOCKS.filter(r=>{
  const a=origin+(r.x-r.y-r.d)*step,b=origin+(r.x+r.w-r.y)*step;
  return right>=a&&left<=b;
 });
 return overlapping.length>0&&overlapping.every(r=>x>=r.x+r.w||y>=r.y+r.d);
}

function build(environment){
const NIGHT=!!environment.night;
const lights=[[-120,-190],[500,-190],[1700,-190],[2110,440],[2110,1400],[-100,800],[460,1880],[1500,1880],[-500,2280],[630,2280],[1710,2290],[2510,2210],[-1220,1320],[-1220,280],[2930,430],[2930,1510],[120,-1210],[1300,-1210],[2530,-1210],[-970,3010],[480,3010],[1820,3010],[3300,2580],[-90,2215],[430,2250],[1200,2245],[2100,2240],[2460,1780],[2470,980],[2460,160],[-560,1730],[2500,2340]];
function tone(color){
 if(color.startsWith('!'))return color.slice(1);
 if(!NIGHT||!/^#[\da-f]{6,8}$/i.test(color))return color;
 const t=[15,29,47],out=[1,3,5].map((i,n)=>Math.round(parseInt(color.slice(i,i+2),16)*.28+t[n]*.72).toString(16).padStart(2,'0')).join('');
 return '#'+out+color.slice(7);
}

const town=canvas(W*2,H*2),b=town.getContext('2d');b.scale(2,2);
// 기존 사무실과 동일한 월드 좌표·사선 투영으로 모든 주변 요소를 그린다.
function p(x,y,z=G){return {x:Math.round(((780+(x-y)*.36)*S+OX)*2)/2,y:Math.round(((125+(x+y)*.18-z)*S+OY)*2)/2};}
const poly=(q,points,color)=>polygon(q,points,tone(color));
function plane(q,x,y,w,d,z,color){poly(q,[[x,y],[x+w,y],[x+w,y+d],[x,y+d]].map(([a,b])=>p(a,b,z)),color);}
function face(q,x1,y1,x2,y2,low,high,color){poly(q,[p(x1,y1,low),p(x2,y2,low),p(x2,y2,high),p(x1,y1,high)],color);}
function box(q,x,y,w,d,z,h,top,left,right){face(q,x,y+d,x+w,y+d,z,z+h,left);face(q,x+w,y,x+w,y+d,z,z+h,right);plane(q,x,y,w,d,z+h,top);}
const drawables=[];const queue=(x,y,draw,bounds={x,y})=>drawables.push({depth:x+y,draw,front:isOfficeForeground(bounds)});

function road(x,y,w,d,axis){
 plane(b,x-52,y-52,w+104,d+104,G-1,'#a6b4a9');plane(b,x-40,y-40,w+80,d+80,G,'#d2d3be');plane(b,x,y,w,d,G+1,'#839294');
 const edge=tone('#e4dfc9');
 for(const off of [7,(axis==='x'?d:w)-8]){
  if(axis==='x'){line(b,p(x,y+off,G+2),p(x+w,y+off,G+2),edge);}else line(b,p(x+off,y,G+2),p(x+off,y+d,G+2),edge);
 }
 if(axis==='x')for(let u=x+40;u<x+w-40;u+=160)plane(b,u,y+d/2-2,70,4,G+2,'#e8d5a0');
 else for(let u=y+40;u<y+d-40;u+=160)plane(b,x+w/2-2,u,4,70,G+2,'#e8d5a0');
}
function crossing(x,y,axis){for(let n=0;n<7;n++)if(axis==='x')plane(b,x+n*25,y,12,155,G+3,'#ece9d4');else plane(b,x,y+n*25,155,12,G+3,'#ece9d4');}

function tree(q,x,y,size=1){
 const v=p(x,y,G),r=(dx,dy,w,h,col)=>{q.fillStyle=tone(col);q.fillRect(v.x+Math.round(dx*size),v.y+Math.round(dy*size),Math.max(1,Math.round(w*size)),Math.max(1,Math.round(h*size)));};
 r(-17,0,34,5,'#8fa08d');r(-2,-33,4,36,'#8f8872');r(2,-29,3,30,'#706f5d');
 for(const [dx,dy,w,h,col]of [[-21,-50,38,18,'#71957d'],[-14,-63,31,21,'#7ea68b'],[-23,-44,28,17,'#64866f'],[-11,-49,35,17,'#86a786'],[-14,-63,13,10,'#a3b88e'],[8,-43,15,9,'#6f9379'],[-7,-73,22,14,'#8eac87'],[-4,-72,9,5,'#b0c397']])r(dx,dy,w,h,col);
}
function glow(q,x,y,z,rx,ry,rgb,strength){const a=p(x,y,z);q.save();q.translate(a.x,a.y);q.scale(rx,ry);const g=q.createRadialGradient(0,0,0,0,0,1);g.addColorStop(0,`rgba(${rgb},${strength})`);g.addColorStop(.4,`rgba(${rgb},${strength*.45})`);g.addColorStop(1,`rgba(${rgb},0)`);q.fillStyle=g;q.fillRect(-1,-1,2,2);q.restore();}
function lamppost(q,x,y){const a=p(x,y,G),t=p(x,y,G+116);line(q,a,t,tone('#718383'));line(q,{x:t.x,y:t.y+8},{x:t.x+13,y:t.y+8},tone('#718383'));q.fillStyle=tone('#899b93');q.fillRect(t.x+6,t.y+2,18,4);q.fillStyle=NIGHT?'#ffe5a8':'#e7d8ad';q.fillRect(t.x+8,t.y+6,14,3);if(NIGHT)glow(q,x+48,y,G+108,21,15,'255,205,122',.58);}
function planter(q,x,y,w=82){box(q,x,y,w,44,G,18,'#b8b69b','#9b9f87','#85947f');for(let n=0;n<4;n++)tree(q,x+12+n*18,y+20,.36);}
function house(q,h){
 if(h.kind==='machiya')return machiya(q,h);
 const{x,y,w,d,height,top,front,side,roof,label,kind='home'}=h;
 box(q,x,y,w,d,G,height,top,front,side);
 const wall=(u1,u2,z1,z2,color)=>face(q,x+u1,y+d,x+u2,y+d,G+z1,G+z2,color);
 wall(0,w,0,9,'#94a593');wall(0,w,height-8,height-4,'#e8dcc3');
 for(let row=0;row<3;row++)for(let k=0;k<4;k++){const a=12+k*(w-30)/4+(row%2?14:0),z=12+row*13;if(a<w-25)wall(a,Math.min(w-12,a+22),z,z+1,'#8a9b8c26');}
 const floors=height>180?2:1;
 for(let row=0;row<floors;row++){
  const z=height-25-row*80,cols=kind==='shop'?3:2;
  for(let j=0;j<cols;j++){
   const bw=(w-44)/cols,a=22+j*bw+7,bend=Math.min(w-25,a+bw-20);
   wall(a-3,bend+3,z-59,z+3,'#748d91');wall(a,bend,z-56,z,'#a7c4c0');
   // 창 안의 소품과 가림막은 사무실 소품처럼 작은 도트로 표현한다.
   if((j+row+h.seed)%3===0){wall(a+6,bend-6,z-54,z-38,'#b1bdab');for(let n=0;n<4;n++)wall(a+8,bend-8,z-51+n*3,z-50+n*3,'#d9d9be');}
   else{wall(a+7,bend-7,z-52,z-47,'#9aab9b');wall(a+13,a+28,z-47,z-35,'#bfaa8a');wall(a+16,a+26,z-35,z-25,'#87a58a');wall(a+10,a+31,z-31,z-24,'#96b395');if(j%2)wall(bend-23,bend-9,z-47,z-36,'#889ea0');}
   wall(a+3,Math.min(bend,a+10),z-52,z-5,'#d4e3d1');wall((a+bend)/2-1,(a+bend)/2+1,z-56,z,'#6f8d90');wall(a-4,bend+4,z-62,z-58,'#d6cbb0');
   wall(a-6,bend+5,z+3,z+7,'#ded3b9');
   if((j+row+h.seed)%3===0)wall(a+3,bend-3,z-13,z-8,'#e7d3a2');
  }
 }
 for(let j=0;j<2;j++){const a=y+25+j*(d-50)/2;face(q,x+w,a,x+w,a+(d-50)/2-18,G+height-65,G+height-20,'#859fa5');face(q,x+w,a+5,x+w,a+9,G+height-62,G+height-24,'#bbd1c7');}
 if(roof==='gable'){
  const r=height+42;
  poly(q,[p(x-12,y-12,G+height),p(x+w/2,y-12,G+r),p(x+w/2,y+d+12,G+r),p(x-12,y+d+12,G+height)],'#a47869');
  poly(q,[p(x+w/2,y-12,G+r),p(x+w+12,y-12,G+height),p(x+w+12,y+d+12,G+height),p(x+w/2,y+d+12,G+r)],'#876f68');
  for(let n=1;n<6;n++){const yy=y-12+(d+24)*n/6;line(q,p(x-12,yy,G+height),p(x+w/2,yy,G+r),'#bc9381');line(q,p(x+w/2,yy,G+r),p(x+w+12,yy,G+height),'#9c8175');}
 }else{
  box(q,x-9,y-9,w+18,d+18,G+height,9,'#d0c8b2','#b8ac96','#9ca796');
  box(q,x+25,y+25,70,55,G+height+9,17,'#aab4ae','#849b97','#71868a');
  for(let k=0;k<4;k++)plane(q,x+30+k*12,y+30,5,40,G+height+27,'#c8d0bf');
  if(h.seed%2)box(q,x+w-85,y+d-80,62,45,G+height+9,22,'#bab694','#929d83','#7a927c');
  for(let n=0;n<22;n++){const xx=x+15+(n*37)%(w-30),yy=y+15+(n*61)%(d-30);plane(q,xx,yy,3+n%3*2,2,G+height+9.2,n%3?'#acb5a73a':'#e4ddc65c');}
  line(q,p(x+6,y+6,G+height+9),p(x+w-6,y+6,G+height+9),'#e6e1cc');line(q,p(x+w-6,y+6,G+height+9),p(x+w-6,y+d-6,G+height+9),'#909e91');
 }
 const pa=p(x+w-10,y+d+1,G+height-10),pb=p(x+w-10,y+d+1,G+8);line(q,pa,pb,'#879d99');
 wall(w-55,w-23,18,46,'#8b9e99');for(let n=0;n<3;n++)wall(w-52,w-26,23+n*6,25+n*6,'#bcc9b7');
 if(kind==='home'){wall(14,61,9,62,'#829c98');wall(18,57,12,58,'#b1c5b9');wall(46,49,27,36,'#e2d4b7');}
 if(kind==='shop'){
  const z=height-8;
  wall(12,w-12,z-20,z,front==='#dfc49e'?'#7fa39c':'#ae888b');
  const s=p(x+w/2,y+d+1,G+z-12);q.font='10px "Malgun Gothic"';q.textAlign='center';q.fillStyle='#fff2cb';q.fillText(label,s.x,s.y);
  for(let k=0;k<7;k++){const a=x+8+k*(w-16)/7;poly(q,[p(a,y+d,G+70),p(a+(w-16)/7,y+d,G+70),p(a+(w-16)/7,y+d+34,G+58),p(a,y+d+34,G+58)],k%2?'#e3c9b0':'#88aca3');}
 }
 planter(q,x+12,y+d+24,62);
}
function machiya(q,h){
 const{x,y,w,d,height,seed}=h,wood=['#726454','#675c50','#81715b'][seed%3],cream=['#d4cbb1','#bfbca7','#d3c3a9','#b7c3b2'][seed%4];
 if(seed%7===0)return house(q,{...h,kind:seed%2?'shop':'home',label:seed%2?'喫茶':'',roof:'flat',top:'#b9b7a6',front:cream,side:'#a7ada1'});
 const f=(a,e,z1,z2,col)=>face(q,x+a,y+d,x+e,y+d,G+z1,G+z2,col);
 box(q,x,y,w,d,G,height,cream,cream,'#a3ac9c');
 f(0,w,0,15,'#7a8278');f(0,w,15,68,wood);
 for(const a of [0,w/2,w-9])f(a,a+9,12,height,wood);
 for(let a=16;a<w-8;a+=13)f(a,a+3,16,65,wood);
 // 나무 기둥과 작은 창으로 옆면의 큰 빈 면을 나눈다.
 for(let yy=y+13;yy<y+d-10;yy+=62)face(q,x+w+.5,yy,x+w+.5,yy+4,G+15,G+height-4,wood);
 for(let z=28;z<height-24;z+=83){
  const aa=y+d*.35,ee=y+d*.77;
  face(q,x+w+1,aa,x+w+1,ee,G+z,G+z+43,wood);
  face(q,x+w+1,aa+5,x+w+1,ee-5,G+z+4,G+z+39,NIGHT&&(seed+z)%3===0?'!#9c9572':'#8fa6a0');
  for(let yy=aa+16;yy<ee-4;yy+=17)face(q,x+w+1,yy,x+w+1,yy+2,G+z+4,G+z+39,wood);
 }
 const stories=height>175?2:1;
 for(let r=0;r<stories;r++){
  const z=r?height-25:80,lo=r?height-79:25,cols=w>320?3:2;
  for(let j=0;j<cols;j++){
   const a=16+j*(w-32)/cols,e=a+(w-32)/cols-13,lit=NIGHT&&(j+r+seed)%4!==0;
   f(a-3,e+3,lo-3,z+3,wood);f(a,e,lo,z,lit?'!#b3a16f':'#8da5a0');
   if(lit){f(a+4,e-4,z-13,z-3,'!#e0c68b');f(a+8,e-7,lo+3,lo+11,'!#8e8b67');}
   for(let k=1;k<7;k++){const t=a+(e-a)*k/7;f(t,t+2,lo,z,wood);}
   f(a,e,lo+20,lo+23,wood);f(a-4,e+4,lo-7,lo-3,'#a0937b');
  }
 }
 // 맞배·팔작형 지붕을 섞고 용마루와 도트 기와로 표면을 나눈다.
 const roof=['#718185','#6b787e','#89857b','#747f78','#937e6c'][seed%5],ridge=height+38+(seed%3)*7,hip=seed%3===0;
 const a=p(x-20,y-17,G+height),bb=p(x+w+20,y-17,G+height),cc=p(x+w+20,y+d+28,G+height),dd=p(x-20,y+d+28,G+height);
 const r1=p(x+w/2,y+(hip?d*.2:-17),G+ridge),r2=p(x+w/2,y+(hip?d*.78:d+28),G+ridge);
 if(!hip){poly(q,[p(x,y+d,G+height),p(x+w,y+d,G+height),p(x+w/2,y+d,G+ridge-3)],cream);line(q,p(x,y+d+1,G+height),p(x+w/2,y+d+1,G+ridge-3),tone(wood));line(q,p(x+w/2,y+d+1,G+ridge-3),p(x+w,y+d+1,G+height),tone(wood));}
 poly(q,[a,r1,r2,dd],roof);poly(q,[r1,bb,cc,r2],seed%5===4?'#766e64':'#566b72');
 if(hip){poly(q,[a,bb,r1],'#87938b');poly(q,[dd,r2,cc],roof);}
 const lo=y+(hip?d*.2:-17),hi=y+(hip?d*.78:d+28);
 // 기와 선을 해당 지붕 면으로 잘라 처마 밖으로 튀어나오는 조각을 막는다.
 for(const[right,points]of [[false,[a,r1,r2,dd]],[true,[r1,bb,cc,r2]]]){
  q.save();q.beginPath();points.forEach((v,i)=>i?q.lineTo(v.x,v.y):q.moveTo(v.x,v.y));q.closePath();q.clip();
  for(let yy=lo+10;yy<hi;yy+=23){
   if(right)line(q,p(x+w/2,yy,G+ridge+1),p(x+w+17,yy,G+height+1),tone('#76898a'));
   else line(q,p(x-17,yy,G+height+1),p(x+w/2,yy,G+ridge+1),tone('#8c9995'));
  }
  if(!right)for(let k=1;k<5;k++){
   const xx=x-20+(w/2+20)*k/5,zz=height+(ridge-height)*k/5;
   line(q,p(xx,lo,G+zz),p(xx,hi,G+zz),tone('#65787b'));
  }
  q.restore();
 }
 line(q,r1,r2,tone('#a1aaa1'));
 if(seed%6===1)box(q,x+w*.6,y+d*.3,25,28,G+ridge-11,28,'#a5a795','#8c9488','#748782');
 // 2층 주택에는 작은 처마를, 상점에는 천 가림막과 등을 단다.
 if(stories===2)poly(q,[p(x-12,y+d,G+100),p(x+w+12,y+d,G+100),p(x+w+12,y+d+40,G+91),p(x-12,y+d+40,G+91)],'#5b7077');
 const shop=seed%3!==0;
 if(shop){
  const a=w*.22,e=w*.78,noren=['#6f8d8d','#a18478','#919878','#707f96'][seed%4];
  for(let k=0;k<4;k++)f(a+(e-a)*k/4,a+(e-a)*(k+1)/4-3,53,83,noren);
  const sign=p(x+w*.5,y+d+2,G+69);q.save();q.font='8px "Yu Gothic","Malgun Gothic"';q.textAlign='center';q.fillStyle=NIGHT?'#f0d8a1':'#f0e2c6';q.fillText(['茶房','珈琲','本','食堂','パン','花'][seed%6],sign.x,sign.y);q.restore();
  const lantern=p(x+w-22,y+d+12,G+68);q.fillStyle=tone('#726752');q.fillRect(lantern.x-1,lantern.y-12,2,15);q.fillStyle=NIGHT?'#e5b47a':'#d0b08b';q.fillRect(lantern.x-4,lantern.y-9,8,12);q.fillStyle=NIGHT?'#f6d5a0':'#dfc6a5';q.fillRect(lantern.x-3,lantern.y-8,3,10);
  if(NIGHT)glow(q,x+w-22,y+d+12,G+68,13,15,'255,185,115',.23);
 }
 f(8,45,3,15,'#a39b85');
 box(q,x+w+7,y+d-70,34,52,G+7,35,'#a4aaa1','#899a93','#7a8e88');
 for(let k=0;k<4;k++)face(q,x+w+42,y+d-64+k*9,x+w+42,y+d-59+k*9,G+13,G+34,'#b5beb1');
 if(seed%2===0)planter(q,x+10,y+d+35,44);
}
function vending(q,x,y,color){
 const w=67,d=60,h=112;
 box(q,x,y,w,d,G,h,color,color,'#7d8e91');
 const f=(a,e,z1,z2,col)=>face(q,x+a,y+d+1,x+e,y+d+1,G+z1,G+z2,col);
 f(5,60,42,102,NIGHT?'!#cedcd2':'#c5dbd1');
 for(let row=0;row<3;row++)for(let col=0;col<5;col++){
  const a=10+col*9,z=53+row*16;
  f(a,a+5,z,z+9,['#b47e6a','#9cbea4','#d7c79c','#8daab4','#c2a4b2'][(row+col)%5]);
  f(a,a+5,z-4,z-2,NIGHT?'!#eee7b7':'#ece7c7');
 }
 f(6,61,91,96,NIGHT?'!#eff2ce':'#e8e6cb');f(9,43,13,30,'#536d77');f(13,39,16,23,'#344d5d');f(50,58,30,48,NIGHT?'!#d5dfba':'#bccbbd');
 const l=p(x+34,y+d+2,G+102);q.fillStyle=NIGHT?'#e0f1dd':'#f0e8cc';q.font='5px sans-serif';q.textAlign='center';q.fillText('DRINK',l.x,l.y);
 if(NIGHT)glow(q,x+30,y+d+5,G+76,14,28,'185,227,234',.24);
}
const seven={x:520,y:2310,w:520,d:330,height:120};
function sevenEleven(q){
 const{x,y,w,d,height:h}=seven,front=y+d;
 const f=(a,e,z1,z2,col)=>face(q,x+a,front+1,x+e,front+1,G+z1,G+z2,col);
 box(q,x,y,w,d,G,h,'#c7c6b3','#c4c7b2','#9daea5');
 f(0,w,0,14,'#8a9b93');f(0,w,20,99,'#677e81');
 for(let j=0;j<5;j++){
  const a=12+j*99,e=a+91;
  f(a,e,24,96,NIGHT?'!#b9c9a3':'#bbd1b4');
  // 유리 안쪽 상품 진열대도 다채로운 작은 픽셀로 그린다.
  for(let r=0;r<3;r++){
   f(a+3,e-3,31+r*19,34+r*19,NIGHT?'!#c4cbb0':'#b1bba5');
   for(let k=0;k<8;k++)f(a+5+k*10,a+11+k*10,35+r*19,43+r*19,['#c0a787','#b4937c','#829a9b','#c6be8d','#91ad94'][(k+r+j)%5]);
  }
  f(a+4,a+8,28,91,NIGHT?'!#d2dfc0':'#dce4cc');
 }
 f(395,492,18,96,'#5b7d83');f(402,486,21,93,NIGHT?'!#c4d6b3':'#bdd1bd');f(440,444,22,93,'#f0e4cb');f(451,455,48,61,'#e1dcc2');
 // 세븐일레븐 삼색 띠와 정면 간판.
 for(const[lo,hi,col]of [[98,109,'#e3e1c4'],[108,114,'#db8d49'],[114,118,'#b66251'],[118,126,'#548873'],[126,131,'#e0ddc6']]){f(-7,w+7,lo,hi,NIGHT?'!'+col:col);face(q,x+w+1,y-5,x+w+1,front+5,G+lo,G+hi,NIGHT?'!'+col:col);}
 f(193,323,97,137,NIGHT?'!#ecedcd':'#eeebd6');
 const a=p(x+254,front+3,G+116);q.save();q.translate(a.x,a.y);q.transform(1,.5,0,1,0,0);q.textAlign='center';q.fillStyle='#ca644b';q.font='bold 15px Arial';q.fillText('7',0,-3);q.fillStyle='#3f7f66';q.font='bold 7px Arial';q.fillText('ELEVEN',0,6);q.restore();
 box(q,x-10,y-10,w+20,d+20,G+132,10,'#b3b9ac','#9da69c','#819891');
 box(q,x+55,y+48,92,65,G+142,24,'#a1ada7','#839b96','#6e8788');
 for(let k=0;k<6;k++)plane(q,x+61+k*13,y+53,5,53,G+166,'#c5cbbb');
 box(q,x+w-148,y+48,83,65,G+142,22,'#a1ada7','#839b96','#6e8788');
 box(q,x+w+16,front-17,43,42,G,52,'#afbab0','#889c94','#728d89');
 face(q,x+w+23,front+26,x+w+51,front+26,G+37,G+45,'#4d6c71');
 vending(q,x+w+70,front-60,'#b15c50');vending(q,x+w+145,front-60,'#c5cbbd');
 if(NIGHT)glow(q,x+w*.5,front+15,G+82,65,28,'218,233,184',.18);
}
function lawsonStore(q){
 const{x,y,w,d}=lawson,h=126,front=x+w;
 // 정면은 +X 방향으로, 화면에서는 화살표와 같은 오른쪽 아래를 향한다.
 const f=(a,e,z1,z2,col)=>face(q,front+1,y+d-e,front+1,y+d-a,G+z1,G+z2,col);
 const side=(a,e,z1,z2,col)=>face(q,x+a,y+d+1,x+e,y+d+1,G+z1,G+z2,col);
 if(NIGHT)glow(q,front+52,y+d/2,G+3,64,31,'167,214,236',.3);
 box(q,x,y,w,d,G,h,'#c4cbbc','#c7cdbe','#b7c7bf');
 side(0,w,0,14,'#879e99');side(0,w,14,94,'#b6c4b8');
 // 밝은 청색 띠와 흰 테두리를 두 면에 이어 편의점임을 알아보기 쉽게 한다.
 for(const[lo,hi,col]of [[94,130,'#ecebd9'],[98,126,'#348bbd'],[101,123,'#398fc2']]){
  const c=NIGHT?'!'+col:col;f(-5,d+5,lo,hi,c);side(-5,w+5,lo,hi,c);
 }
 side(20,w-23,33,82,'#849ea1');side(25,w-28,38,77,NIGHT?'!#96b7ba':'#b4ccc2');
 for(let a=40;a<w-28;a+=36)side(a,a+3,38,77,'#7c969c');
 side(17,w-20,29,34,'#d7dbc6');side(10,20,16,92,'#d4d8c6');
 f(0,d,0,15,'#819c9b');f(7,d-7,16,94,'#6e8c93');
 for(let j=0;j<4;j++){
  const a=15+j*(d-30)/4,e=a+(d-30)/4-5;
  f(a,e,21,91,NIGHT?'!#b7d0cc':'#b5cec5');
  for(let r=0;r<3;r++){
   f(a+4,e-4,31+r*17,34+r*17,NIGHT?'!#d4dfce':'#ced6bf');
   for(let k=0;k<6;k++)f(a+6+k*9,a+11+k*9,35+r*17,43+r*17,['#a4bea6','#d3c69f','#a8bec6','#c6ac9d','#afbac7'][(j+r+k)%5]);
  }
  f(a+3,e-3,83,89,NIGHT?'!#eef0d5':'#d9e4cd');f(a+3,a+6,25,79,'#deead7');
 }
 // 정면 왼쪽 출입구와 손잡이, 입구 위 조명을 작은 픽셀로 표현한다.
 f(12,92,17,94,'#66858f');f(18,86,21,90,NIGHT?'!#c3dad0':'#c3d8ca');f(49,52,21,90,'#e5e9d5');
 f(55,58,45,59,'#718f95');f(42,45,45,59,'#718f95');f(9,95,91,95,NIGHT?'!#f3efd2':'#e1e4ce');
 const sign=p(front+2,y+d*.48,G+108);
 q.save();q.translate(sign.x,sign.y);q.transform(1,-.5,0,1,0,0);q.textAlign='center';q.font='bold 11px Arial';q.fillStyle='#f4f3e3';q.fillText('LAWSON',3,0);q.restore();
 // 정면 한쪽에는 우유통 형태의 작은 흰 간판을 둔다.
 f(12,39,102,122,'!#eaf0df');f(17,34,105,119,'#348bbd');f(22,29,108,115,'!#eef1df');f(20,31,115,117,'!#eef1df');
 const sideSign=p(x+w*.5,y+d+2,G+109);
 q.save();q.translate(sideSign.x,sideSign.y);q.transform(1,.5,0,1,0,0);q.textAlign='center';q.fillStyle='#edf0df';q.font='bold 9px Arial';q.fillText('LAWSON',0,0);q.restore();
 box(q,x-9,y-9,w+18,d+18,G+131,10,'#c4cbbe','#a6b6ac','#94aaa4');
 box(q,x+38,y+45,68,83,G+141,23,'#a3b6b0','#8a9f9a','#7b9493');
 for(let n=0;n<5;n++)plane(q,x+44+n*11,y+51,4,69,G+164,'#cad5c7');
 plane(q,x+16,y+16,w-32,3,G+141.2,'#dce0cc');
 box(q,front+20,y+d-25,35,39,G+2,44,'#c4cec1','#9cafaa','#859f9b');
 face(q,front+55,y+d-21,front+55,y+d+10,G+31,G+37,'#577e89');
 if(NIGHT)glow(q,front+5,y+d*.5,G+109,39,19,'157,211,244',.24);
}
function utility(q,x,y){
 const a=p(x,y,G),t=p(x,y,G+204);
 q.strokeStyle=tone('#6c756e');q.lineWidth=3;q.beginPath();q.moveTo(a.x,a.y);q.lineTo(t.x,t.y);q.stroke();
 line(q,{x:t.x-20,y:t.y+9},{x:t.x+23,y:t.y+9},tone('#818c80'));
 for(const dx of [-15,0,17]){q.fillStyle=tone('#b9c1ae');q.fillRect(t.x+dx,t.y+5,4,6);}
}
function bicycle(q,x,y){
 const a=p(x,y,G+10);q.save();q.strokeStyle=tone('#657e80');q.lineWidth=1;
 for(const dx of [-8,8]){q.beginPath();q.arc(a.x+dx,a.y,5,0,Math.PI*2);q.stroke();}
 line(q,{x:a.x-8,y:a.y},{x:a.x-1,y:a.y-8},tone('#a28b76'));line(q,{x:a.x-1,y:a.y-8},{x:a.x+8,y:a.y},tone('#a28b76'));line(q,{x:a.x-8,y:a.y},{x:a.x+4,y:a.y-1},tone('#a28b76'));line(q,{x:a.x+4,y:a.y-1},{x:a.x+5,y:a.y-11},tone('#6d7b76'));line(q,{x:a.x+5,y:a.y-11},{x:a.x+9,y:a.y-12},tone('#6d7b76'));q.restore();
}
function car(q,x,y,color,axis='x'){
 const w=axis==='x'?125:62,d=axis==='x'?62:125;
 for(const [dx,dy]of [[12,5],[w-28,5],[12,d-12],[w-28,d-12]])box(q,x+dx,y+dy,16,8,G+2,15,'#54676b','#45555b','#3c4c54');
 box(q,x,y,w,d,G+12,20,color,color,'#6f939d');
 box(q,x+(axis==='x'?29:6),y+(axis==='x'?6:28),axis==='x'?65:50,axis==='x'?50:65,G+32,18,'#c1d9d4',color,'#6d979f');
 plane(q,x+3,y+3,w-6,3,G+33,'#e2d3b0');
}
const parkedCars=[
 {x:-1330,y:-610,color:'#cbbf9e',axis:'x'},
 {x:-900,y:-620,color:'#a8756b',axis:'x'},
 {x:-700,y:-1140,color:'#92aeb5',axis:'x'},
];
function parkingBay(q,v){
 const w=v.axis==='x'?125:62,d=v.axis==='x'?62:125;
 plane(q,v.x-15,v.y-15,w+30,d+30,G+1,'#abb5a6');
 for(const off of [-12,d+12])plane(q,v.x-12,v.y+off,w+24,2,G+2,'#dddcc2');
 plane(q,v.x-12,v.y-12,2,d+26,G+2,'#dddcc2');
 plane(q,v.x-4,v.y-5,5,d+10,G+3,'#929f95');
}
function parkedCar(q,v){
 const{x,y,color}=v;
 plane(q,x-3,y-2,134,69,G+2,'#7c8e8450');
 for(const dx of [16,94])box(q,x+dx,y+2,19,60,G+3,15,'#4d6268','#43545c','#354b55');
 box(q,x,y,125,62,G+13,17,color,color,'#839fa4');
 // 완만한 앞유리와 낮은 지붕으로 작은 승용차의 실루엣을 만든다.
 poly(q,[p(x+26,y+57,G+30),p(x+106,y+57,G+30),p(x+89,y+54,G+45),p(x+40,y+54,G+45)],'#67858f');
 poly(q,[p(x+89,y+7,G+45),p(x+106,y+3,G+30),p(x+106,y+57,G+30),p(x+89,y+54,G+45)],'#88aab0');
 poly(q,[p(x+26,y+5,G+30),p(x+40,y+8,G+45),p(x+40,y+54,G+45),p(x+26,y+57,G+30)],'#9cb9bb');
 plane(q,x+40,y+7,49,47,G+46,color);
 face(q,x+65,y+56,x+68,y+56,G+30,G+45,color);
 face(q,x+1,y+63,x+124,y+63,G+13,G+17,'#8a9f9d');
 face(q,x+97,y+63,x+117,y+63,G+20,G+24,'#cdd0bc');
 for(const dx of [16,94]){face(q,x+dx,y+63,x+dx+19,y+63,G+4,G+16,'#42545d');face(q,x+dx+6,y+64,x+dx+13,y+64,G+7,G+13,'#94a7a4');}
 face(q,x+125,y+7,x+125,y+17,G+20,G+27,'#e1d8b6');
 face(q,x+125,y+45,x+125,y+55,G+20,G+27,'#e1d8b6');
 face(q,x+1,y+8,x+1,y+15,G+20,G+26,'#aa7568');
}


// 낮은 주택·상점·골목이 화면 가장자리까지 이어지는 교토풍 동네 시안.
b.fillStyle=tone('#c7ceba');b.fillRect(0,0,W,H);
plane(b,-3400,-3500,8500,8500,G-5,'#c3cbb6');
for(let n=0;n<950;n++){const x=-3200+(n*173)%8200,y=-3200+(n*283)%8200;plane(b,x,y,18+n%3*7,7,G-3,n%3?'#acb9a455':'#e2e0bd55');}
const roads=[[-3200,-460,8100,225,'x'],[-410,-3300,225,8200,'y'],[2200,-3300,225,8200,'y'],[-3200,1980,8100,235,'x'],[-3200,-1880,8100,130,'x'],[-3200,2960,8100,120,'x'],[-1720,-3300,125,8200,'y'],[3300,-3300,125,8200,'y']];
for(const args of roads)road(...args);
// 교차로에서 뒤에 그린 보도가 앞 도로의 선을 잘라 남기는 조각을 정리한다.
for(const h of roads.filter(r=>r[4]==='x'))for(const v of roads.filter(r=>r[4]==='y')){
 if(v[0]>=h[0]&&v[0]+v[2]<=h[0]+h[2]&&h[1]>=v[1]&&h[1]+h[3]<=v[1]+v[3]){
  plane(b,v[0],h[1]-40,v[2],h[3]+80,G+1,'#839294');
  plane(b,v[0]-40,h[1],v[2]+80,h[3],G+1,'#839294');
 }
}
// 입구 쪽 보행 정원은 기존 U자 사무실 외곽과 연결된다.
plane(b,-25,10,2180,1875,G+1,'#d4d5bd');
plane(b,704,1230,888,650,G+2,'#bdcbb0');plane(b,1010,1240,165,790,G+3,'#dcd5bc');plane(b,735,1450,805,105,G+3,'#dcd5bc');
for(let n=0;n<5;n++){const x=765+n*155;queue(x+42,1672,q=>planter(q,x,1650,85));}
for(const [x,y,axis]of [[2165,2000,'x'],[-395,2010,'x'],[2225,-480,'y'],[-420,-470,'y']])crossing(x,y,axis);
const houses=[];
const overlaps=(a,z)=>a.x<z.x+z.w+35&&a.x+a.w>z.x-35&&a.y<z.y+z.d+35&&a.y+a.d>z.y-35;
function addHouse(x,y,seed){
 const w=260+(seed*31)%106,d=300+(seed*17)%76;
 const a={x,y,w,d};
 if(roads.some(([x,y,w,d])=>overlaps(a,{x,y,w,d})))return;
 if(overlaps(a,{x:-25,y:10,w:2180,d:1875})||overlaps(a,{...seven,w:seven.w+240,d:seven.d+100}))return;
 houses.push({...a,height:seed%3===0?125+(seed%2)*13:175+(seed%4)*14,kind:'machiya',seed});
}
let seed=0;
for(const y of [-3200,-2630,-1560,-1010])for(let x=-2940;x<4700;x+=440)addHouse(x+(seed%3)*11,y+(seed%2)*17,++seed);
for(const x of [-2940,-2350,-1370,-890,2550,3640,4100])for(let y=-260;y<2830;y+=520)addHouse(x+(seed%2)*17,y+(seed%3)*12,++seed);
for(const y of [2360,3260,3810,4370])for(let x=-2940;x<4700;x+=450)addHouse(x+(seed%2)*15,y+(seed%3)*13,++seed);
const lawsonIndex=houses.findIndex(h=>h.seed===65&&h.x===1471&&h.y===-1010);
if(lawsonIndex<0)throw new Error('교체할 주택 위치를 찾지 못했습니다.');
const[lawson]=houses.splice(lawsonIndex,1);
// 작은 정원과 재질·높이·상점 전면을 달리해 반복을 줄인다.
for(const h of houses){
 plane(b,h.x-18,h.y-15,h.w+36,h.d+76,G+1,'#b4b6a1');
 if(h.seed%5===0)plane(b,h.x+h.w+18,h.y+35,55,h.d-25,G+2,'#a8bb9c');
 queue(h.x+h.w/2,h.y+h.d/2,q=>house(q,h),h);
 if(h.seed%5===0)queue(h.x+h.w+42,h.y+h.d-30,q=>tree(q,h.x+h.w+42,h.y+h.d-30,.6));
 if(h.seed%7===0)queue(h.x+h.w-55,h.y+h.d+65,q=>bicycle(q,h.x+h.w-55,h.y+h.d+65));
}
// 지면은 건물·나무보다 먼저 그려 포장면이 기둥이나 선을 덮지 않게 한다.
plane(b,seven.x-38,seven.y-20,seven.w+125,seven.d+130,G+1,'#c9c9b2');
plane(b,lawson.x-16,lawson.y-15,lawson.w+175,lawson.d+32,G+1,'#b8c1b0');
for(let n=0;n<4;n++)plane(b,lawson.x+lawson.w+16+n*32,lawson.y+15,2,lawson.d-30,G+2,'#d0d4bf');
for(const v of parkedCars)parkingBay(b,v);
queue(seven.x+seven.w/2,seven.y+seven.d/2,q=>sevenEleven(q),seven);
queue(lawson.x+lawson.w/2,lawson.y+lawson.d/2,q=>lawsonStore(q),lawson);
queue(2540,1250,q=>vending(q,2540,1250,'#c6c6b3'));
for(const [x,y]of [[-600,-700],[130,-600],[720,-570],[1350,-580],[1950,-600],[2530,-520],[-560,200],[-560,650],[-560,1300],[-540,1780],[2520,320],[2520,1120],[2520,1800],[1450,2340],[1920,2340],[-1250,2230],[-970,2820],[3070,2450]])queue(x,y,q=>tree(q,x,y,.7+(Math.abs(x)%3)*.06));
if(NIGHT){
 for(const[x,y]of lights)glow(b,x+27,y+8,G+2,82,40,'255,205,130',.31);
 glow(b,seven.x+260,seven.y+seven.d+70,G+2,110,52,'225,232,180',.32);
 for(const[x,y]of [[seven.x+seven.w+100,seven.y+seven.d+12],[seven.x+seven.w+175,seven.y+seven.d+12],[2570,1330]])glow(b,x,y,G+3,35,23,'180,225,240',.28);
}
for(const [x,y]of lights)queue(x,y,q=>lamppost(q,x,y));
for(const[x,y]of [[-1520,520],[-1520,1720],[3100,-100],[3100,1500],[-1250,2820]])queue(x,y,q=>utility(q,x,y));
for(const [x,y,color,axis]of [[630,-400,'#b77969','x'],[2270,920,'#a7bcd0','y'],[1300,2040,'#d9c49b','x'],[-350,1150,'#97b7a6','y']])queue(x+60,y+60,q=>car(q,x,y,color,axis));
for(const v of parkedCars)queue(v.x+62,v.y+31,q=>parkedCar(q,v));

const extraTrees=[[-95,120],[-90,470],[-95,1070],[-85,1480],[-80,1730],[150,1890],[730,1890],[1030,1890],[1310,1890],[1790,1880],[2060,1880],[2140,145],[2140,810],[2140,1130],[2140,1720],[-420,-610],[60,-610],[400,-610],[1030,-610],[1360,-610],[2060,-610],[-1420,-500],[-1420,800],[-1420,1820],[3080,700],[3080,1880],[1360,2800],[1980,2780],[300,2750]];
for(const[x,y]of extraTrees)queue(x,y,q=>tree(q,x,y,.63));
for(const h of houses)if(h.seed%4===1&&h.seed%5!==0)queue(h.x+h.w+35,h.y+h.d-90,q=>tree(q,h.x+h.w+35,h.y+h.d-90,.52));
drawables.sort((a,b)=>a.depth-b.depth);
for(const item of drawables)if(!item.front)item.draw(b);


function lowerStory(q){
 const walls=[[2088,64,2088,1200],[32,1200,2088,1200],[704,1360,704,1800],[32,1800,704,1800],[2088,1360,2088,1760],[1592,1760,2088,1760]];
 const pieces=walls.flatMap(([x1,y1,x2,y2])=>{const len=Math.hypot(x2-x1,y2-y1),n=Math.ceil(len/270);return Array.from({length:n},(_,i)=>({x1:x1+(x2-x1)*i/n,y1:y1+(y2-y1)*i/n,x2:x1+(x2-x1)*(i+1)/n,y2:y1+(y2-y1)*(i+1)/n}));}).sort((a,b)=>a.x1+a.y1+a.x2+a.y2-b.x1-b.y1-b.x2-b.y2);
 for(const [i,w]of pieces.entries()){
  const side=w.x1===w.x2,len=Math.hypot(w.x2-w.x1,w.y2-w.y1),ux=(w.x2-w.x1)/len,uy=(w.y2-w.y1)/len;
  const f=(a,b,z1,z2,col)=>face(q,w.x1+ux*a,w.y1+uy*a,w.x1+ux*b,w.y1+uy*b,z1,z2,col);
  f(0,len,G,-16,side?'#96ada9':'#b5bca8');f(0,len,G,G+13,'#7b9590');f(0,len,-30,-16,'#d4d1b8');
  const door=!side&&w.y1===1200&&w.x1<1100&&w.x2>1000;
  const a=18,bb=len-18;
  f(a-4,bb+4,G+25,-45,'#647e82');f(a,bb,G+29,-49,NIGHT?(i%4===1?'!#aaa780':'!#748d8f'):(i%4===1?'#bed0c4':'#abc5c6'));
  if(i%3===0){f(a+8,bb-8,G+33,G+38,'#c2b79e');f(a+17,a+31,G+38,G+57,'#799b8e');f(a+13,a+36,G+53,G+61,'#94b599');}
  else if(i%3===1){f(a+9,bb-9,-72,-52,'#a6b6a8');for(let k=0;k<3;k++)f(a+12,bb-12,-68+k*5,-67+k*5,'#d6ddc9');}
  else{f(a+13,bb-14,G+40,G+44,'#b7ab95');f(a+22,a+49,G+44,G+63,'#6c9194');f(a+25,a+46,G+48,G+60,'#a8c8c2');}
  f(a+4,a+10,G+32,-53,'#dce5d5');f((a+bb)/2-1,(a+bb)/2+1,G+29,-49,'#7a9697');
  f(a-6,bb+6,G+21,G+27,'#d7d3b9');
  if(i%3===0){f(a+8,bb-8,G+45,G+48,'#d7c6a7');f(a+17,a+29,G+50,G+69,'#758d86');}
  if(door){f(a,bb,G+10,-37,'#587883');f(a+6,bb-6,G+15,-43,'#9dbfc0');f((a+bb)/2-2,(a+bb)/2+2,G+15,-43,'#d4dcc6');const label=p((w.x1+w.x2)/2,w.y1,-28);q.fillStyle='#e7dfc8';q.font='10px "Malgun Gothic"';q.textAlign='center';q.fillText('오피스',label.x,label.y);}
  line(q,p(w.x1,w.y1,-16),p(w.x2,w.y2,-16),tone('#e9e0c5'));
 }
}

if(['rain','snow','fog','cloudy'].includes(environment.condition)){b.fillStyle=NIGHT?'#102b4020':'#43657b20';b.fillRect(0,0,W,H);}
lowerStory(b);
const windows=canvas(1600,1000),wc=windows.getContext('2d');
wc.setTransform(1/S,0,0,1/S,-OX/S,-OY/S);wc.imageSmoothingEnabled=false;wc.drawImage(town,0,0,W,H);
const foreground=canvas(W*2,H*2),fg=foreground.getContext('2d');fg.scale(2,2);
for(const item of drawables)if(item.front)item.draw(fg);
for(const[x,y]of [[850,1840],[1350,1840]])tree(fg,x,y,.55);
if(['rain','snow','fog','cloudy'].includes(environment.condition)){
 fg.save();fg.globalCompositeOperation='source-atop';fg.fillStyle=NIGHT?'#102b4020':'#43657b20';fg.fillRect(0,0,W,H);fg.restore();
}
// 같은 원점의 전경 한 장을 사용해 확대 시 조각 사이의 이음새를 만들지 않는다.
return {town,windows,foreground,drawForeground(ctx){
 ctx.save();ctx.imageSmoothingEnabled=false;
 ctx.drawImage(foreground,0,0);
 ctx.restore();
}};
}

export function scenery(environment,t=0){
 const key=Boolean(environment.night)+':'+['rain','snow','fog','cloudy'].includes(environment.condition);
 if(cached?.key!==key){releaseScenery();cached={key,...build(environment)};}
 const updateWindows=source=>{const wc=cached.windows.getContext('2d');wc.setTransform(1,0,0,1,0,0);wc.clearRect(0,0,1600,1000);wc.setTransform(1/S,0,0,1/S,-OX/S,-OY/S);wc.drawImage(source,0,0,W,H);};
 if(!['rain','snow'].includes(environment.condition)){
  if(cached.weatherActive){updateWindows(cached.town);cached.weatherActive=false;}
  return cached;
 }
 frame ||= canvas(VIEW.width,VIEW.height);
 const c=frame.getContext('2d');c.setTransform(2,0,0,2,0,0);c.imageSmoothingEnabled=false;c.drawImage(cached.town,0,0,W,H);
 if(environment.condition==='rain'){
  c.strokeStyle=environment.night?'#b8cddd60':'#eef9fa92';c.lineWidth=1;c.beginPath();
  for(let i=0;i<240;i++){const x=((i*193-t/30)%W+W)%W,y=(i*131+t/5)%(H+30)-20;c.moveTo(x,y);c.lineTo(x-4,y+13);}c.stroke();
 }else{
  c.fillStyle='#eef5f3d9';
  for(let i=0;i<160;i++){const x=(i*173+Math.sin(t/1800+i)*14+W)%W,y=(i*113+t/(38+i%4*14))%(H+12)-6;c.fillRect(Math.round(x),Math.round(y),i%4?1.5:3,i%4?1.5:3);}
 }
 updateWindows(frame);cached.weatherActive=true;
 return {...cached,town:frame};
}

export function releaseScenery(){
 for(const c of [cached?.town,cached?.windows,cached?.foreground,frame])if(c)c.width=c.height=0;
 cached=frame=null;
}
