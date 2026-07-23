// Demo source for code-graph's own README/marketplace preview images —
// deliberately small, but touches every node kind "Уровень 0" draws: an
// entry point, an ISR, peripherals (read+write, DMA-flow CMAR/CPAR), and a
// couple of plain/volatile globals.

typedef struct { unsigned char data[64]; unsigned char len; } TxMsg;

static TxMsg        tx_q[8];
static unsigned char tx_head, tx_tail;
static volatile unsigned char dma_busy;
static unsigned short         adc_val;

static void dma_kick(void)
{
    TxMsg *m = &tx_q[tx_tail];
    dma_busy = 1;
    DMA1_Channel4->CCR  &= ~DMA_CCR_EN;
    DMA1_Channel4->CMAR  = (unsigned int)(m->data);
    DMA1_Channel4->CPAR  = (unsigned int)(&USART1->DR);
    DMA1_Channel4->CNDTR = m->len;
    DMA1_Channel4->CCR  |= DMA_CCR_EN;
}

void uart_send(const unsigned char *data, unsigned char len)
{
    TxMsg *m = &tx_q[tx_head];
    for (unsigned char i = 0; i < len; i++) m->data[i] = data[i];
    m->len = len;
    tx_head = (unsigned char)((tx_head + 1) % 8);
    if (!dma_busy) dma_kick();
}

void DMA1_Channel4_IRQHandler(void)
{
    if (!(DMA1->ISR & DMA_ISR_TCIF4)) return;
    DMA1->IFCR = DMA_IFCR_CTCIF4;
    dma_busy = 0;
    tx_tail = (unsigned char)((tx_tail + 1) % 8);
    if (tx_tail != tx_head) dma_kick();
}

static unsigned short adc_read(void)
{
    while (!(ADC1->SR & ADC_SR_EOC)) ;
    adc_val = (unsigned short)ADC1->DR;
    return adc_val;
}

int main(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_ADC1EN;
    for (;;) {
        adc_read();
        uart_send(tx_q[0].data, 4);
    }
}
