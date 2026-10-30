import { CITY_BLOCKS } from './cityscape.js';
import { PIXEL_DETAIL } from './raster.js';

// 불투명 간판 판 없이 일본어 튜브와 입체 아이콘을 건물 벽에 고정한다.
export const NEON_SIGNS={
  55:[{side:true,u:18,drop:18,w:23,h:66,kind:'hotel',text:'ホテル',color:'#ff568f',accent:'#ffe1a3'}],
  41:[{side:false,u:8,drop:16,w:43,h:25,kind:'jazz',text:'ジャズ',color:'#39ffe0',accent:'#fbdca6'}],
  31:[
    {side:true,u:39,drop:52,w:50,h:61,kind:'record',text:'レコード',color:'#ffb236',accent:'#ffc4d7'},
    {side:false,u:77,drop:166,w:25,h:90,kind:'tea',text:'喫茶',color:'#ff37b6',accent:'#efd1fa'},
  ],
  13:[
    {side:false,u:12,drop:10,w:49,h:27,kind:'cinema',text:'シネマ',color:'#ff686b',accent:'#ffdd9d'},
    {side:true,u:1,drop:61,w:18,h:65,kind:'bar',text:'バー',color:'#38eaff',accent:'#d6d3ff'},
  ],
  71:[
    {side:false,u:81,drop:164,w:27,h:91,kind:'vertical-record',text:'レコード',color:'#e85bff',accent:'#ffc5d2'},
    {side:false,u:47,drop:1,w:44,h:49,kind:'coffee',text:'喫茶',color:'#43ffe1',accent:'#ffe7ad'},
  ],
  61:[{side:false,u:16,drop:-18,w:37,h:16,kind:'roof',text:'ホテル',color:'#fa8cfc',accent:'#f9d5cc',roof:true}],
  23:[{side:false,u:11,drop:-12,w:32,h:14,kind:'roof',text:'喫茶',color:'#65f4ff',accent:'#e6e9c7',roof:true}],
};
const D=PIXEL_DETAIL,PAD=24;
function makeTexture(sign){
  const {w,h,color,accent,kind,text}=sign;
  const shape=document.createElement('canvas');shape.width=(w+PAD*2)*D;shape.height=(h+PAD*2)*D;
  const c=shape.getContext('2d');c.scale(D,D);c.translate(PAD,PAD);c.lineJoin='round';c.lineCap='round';
  const line=(points,tint,width=1,closed=false)=>{
    c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));if(closed)c.closePath();
    c.strokeStyle=tint;c.lineWidth=width;c.stroke();
  };
  const circle=(x,y,r,tint,width=1)=>line(Array.from({length:48},(_,i)=>[x+Math.cos(i/48*Math.PI*2)*r,y+Math.sin(i/48*Math.PI*2)*r]),tint,width,true);
  const word=(value,x,y,size,tint)=>{c.textAlign='center';c.textBaseline='middle';c.font=`600 ${size}px 'Yu Gothic','MS Gothic',sans-serif`;c.fillStyle=tint;c.fillText(value,x,y);};
  const star=(x,y,r,tint)=>{line([[x-r,y],[x+r,y]],tint,.8);line([[x,y-r],[x,y+r]],tint,.8);};
  if(kind==='record'){
    circle(w*.5,23,18.5,color,1.5);circle(w*.5,23,14.8,color,.65);circle(w*.5,23,7.7,accent,.9);circle(w*.5,23,2.4,accent,1.1);
    line([[w*.5+7,11],[w*.5+14,15],[w*.5+8,28],[w*.5+5,28]],accent,1.1);
    star(3,8,2.3,accent);star(w-3,37,2,accent);
    word(text,w/2,49,10.2,color);line([[5,58],[w-6,58],[w-10,55]],accent,.85);
  }else if(kind==='coffee'){
    line([[8,18],[10,31],[27,31],[30,18],[8,18]],color,1.4);
    line([[30,20],[36,19],[38,22],[36,27],[30,27]],color,1.15);
    line([[7,34],[32,34]],accent,1.1);line([[13,12],[11,9],[14,5]],accent,.95);line([[23,13],[21,9],[24,4]],accent,.95);
    star(38,8,2.8,accent);word(text,w/2,44,10.5,color);
  }else if(kind==='tea'){
    word('喫',w/2,19,17,color);word('茶',w/2,43,17,color);
    line([[5,63],[6,73],[17,73],[19,63],[5,63]],accent,1.1);line([[19,64],[23,65],[23,69],[19,70]],accent,.9);
    line([[9,58],[8,55],[10,52]],accent,.75);line([[5,80],[19,80]],color,.8);
    star(21,3,2,accent);
  }else if(kind==='hotel'){
    [...text].forEach((v,i)=>word(v,w/2,10+i*17,14.5,i===1?accent:color));
    line([[4,60],[19,60],[15,56]],accent,.9);star(2,4,2,accent);
  }else if(kind==='vertical-record'){
    [...text].forEach((v,i)=>word(v,w/2,13+i*18,16,i%2?accent:color));
    circle(w/2,85,3.5,color,.8);line([[4,3],[11,3]],accent,.8);
  }else if(kind==='bar'){
    [...text].forEach((v,i)=>word(v,w/2,15+i*20,15,i?accent:color));
    line([[3,48],[15,48],[8,56],[8,62],[4,62],[13,62]],color,1.1);star(14,4,1.7,accent);
  }else if(kind==='jazz'){
    word(text,26,11,12,color);line([[7,5],[7,16],[3,18],[1,16],[3,14],[7,14]],accent,1);
    line([[8,5],[13,3],[13,8]],accent,1);line([[16,23],[39,23],[36,20]],accent,.85);
  }else if(kind==='cinema'){
    word(text,w/2,9,12,color);line([[2,25],[12,17],[24,25],[36,17],[47,25]],accent,1.1);
    for(let x=7;x<w-3;x+=7)star(x,1,.7,accent);
  }else word(text,w/2,h/2,Math.min(11,h-3),color);

  const recolor=tint=>{const out=document.createElement('canvas');out.width=shape.width;out.height=shape.height;const g=out.getContext('2d');g.drawImage(shape,0,0);g.globalCompositeOperation='source-in';g.fillStyle=tint;g.fillRect(0,0,out.width,out.height);return out;};
  const side=recolor('#63476f'),shadow=recolor('#090e27'),white=recolor('#fff5e9');
  const bake=lit=>{
    const out=document.createElement('canvas');out.width=shape.width;out.height=shape.height;
    const g=out.getContext('2d');g.scale(D,D);g.translate(PAD,PAD);
    const draw=(image,dx=0,dy=0)=>g.drawImage(image,dx-PAD,dy-PAD,w+PAD*2,h+PAD*2);
    g.save();g.globalAlpha=.5;g.filter='blur(2px)';draw(shadow,3,4);g.restore();
    // 빛 번짐은 최초 제작 때만 계산한다. 매 프레임에는 완성된 작은 이미지만 복사한다.
    if(lit)for(const [blur,opacity] of [[11,.38],[5,.58],[1.6,.75]]){
      g.save();g.filter=`blur(${blur}px)`;g.globalAlpha=opacity;draw(shape,-2,-1);g.restore();
    }
    for(let depth=3;depth>0;depth--){g.globalAlpha=.9;draw(side,-2+depth,-1+depth*.6);}
    g.globalAlpha=1;g.imageSmoothingEnabled=false;draw(lit?shape:side,-2,-1);
    if(lit){g.globalAlpha=.4;g.globalCompositeOperation='screen';draw(white,-2.4,-1.5);}
    return out;
  };
  const art={on:bake(true),off:bake(false)};
  for(const image of [shape,side,shadow,white])image.width=image.height=0;
  return art;
}

// 각각 다른 주기로 짧게 소등한다. 빠른 연속 섬광이나 추가 타이머는 사용하지 않는다.
export const NEON_FLICKERS = [
  { seed:31, kind:'tea', period:23000, start:7000, duration:650 },
  { seed:13, kind:'bar', period:29000, start:16000, duration:500 },
  { seed:71, kind:'vertical-record', period:31000, start:24500, duration:800 },
];

export function neonIsOff(t, flicker) {
  if (!Number.isFinite(t) || t < 0) return false;
  const phase=t % flicker.period;
  return phase>=flicker.start && phase<flicker.start+flicker.duration;
}

export function neonPlacement(block, sign) {
  const {side,u,drop,w,h}=sign,start=side?u+w:u;
  const x=side?block.x+block.a-start:block.x+start-block.b;
  const y=block.y+(side?block.a+start:start+block.b)*block.slope+drop;
  const slope=side?-block.slope:block.slope;
  const corners=[[-PAD,-PAD],[w+PAD,-PAD],[-PAD,h+PAD],[w+PAD,h+PAD]];
  const left=Math.floor(x-PAD),top=Math.floor(Math.min(...corners.map(([u,v])=>y+u*slope+v)));
  const right=Math.ceil(x+w+PAD),bottom=Math.ceil(Math.max(...corners.map(([u,v])=>y+u*slope+v)));
  return {x,y,slope,left,top,width:right-left,height:bottom-top};
}

export function createCityNeon() {
  const cache=new Map();
  return {
    draw(ctx,block,unlit=false) {
      for(const sign of NEON_SIGNS[block.seed]||[]){
        let art=cache.get(sign);if(!art){art=makeTexture(sign);cache.set(sign,art);}
        const {x,y,slope}=neonPlacement(block,sign),{w,h,roof}=sign;
        const off=unlit && NEON_FLICKERS.some(f=>f.seed===block.seed && f.kind===sign.kind);
        ctx.save();ctx.transform(1,slope,0,1,x,y);
        ctx.strokeStyle='#72708f';ctx.lineWidth=.7;ctx.beginPath();
        if(roof){ctx.moveTo(5,h+7);ctx.lineTo(5,h-1);ctx.moveTo(w-6,h+7);ctx.lineTo(w-6,h-1);}
        else for(const yy of [8,h-9]){ctx.moveTo(w*.34+4,yy+3);ctx.lineTo(w*.34-3,yy-1);ctx.moveTo(w*.66+4,yy+3);ctx.lineTo(w*.66-3,yy-1);}
        ctx.stroke();ctx.imageSmoothingEnabled=false;
        ctx.drawImage(off?art.off:art.on,-PAD,-PAD,w+PAD*2,h+PAD*2);
        ctx.restore();
      }
    },
    // 가려진 건물·사무실 외벽까지 합성한 소등 장면에서 필요한 세 영역만 보관한다.
    patches(scene,width,height) {
      return NEON_FLICKERS.map(flicker=>{
        const block=CITY_BLOCKS.find(b=>b.seed===flicker.seed);
        const sign=NEON_SIGNS[block.seed].find(s=>s.kind===flicker.kind);
        const bounds=neonPlacement(block,sign);
        const x=Math.max(0,bounds.left),y=Math.max(0,bounds.top);
        const w=Math.max(0,Math.min(width,bounds.left+bounds.width)-x);
        const h=Math.max(0,Math.min(height,bounds.top+bounds.height)-y);
        const canvas=document.createElement('canvas');canvas.width=w*D;canvas.height=h*D;
        if(w && h)canvas.getContext('2d').drawImage(scene,x*D,y*D,w*D,h*D,0,0,w*D,h*D);
        return {canvas,x,y,w,h,flicker};
      });
    },
    release() {
      for(const art of cache.values())for(const image of [art.on,art.off])image.width=image.height=0;
      cache.clear();
    },
  };
}

